use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Extract "major.minor" from the Cargo package version at compile time.
/// e.g. "1.3.1" → "1.3"
const PROTOCOL_VERSION: &str = {
    const V: &str = env!("CARGO_PKG_VERSION");
    const B: &[u8] = V.as_bytes();
    // Find second '.' to truncate at major.minor
    const fn find_second_dot() -> usize {
        let mut dots = 0;
        let mut i = 0;
        while i < B.len() {
            if B[i] == b'.' {
                dots += 1;
                if dots == 2 {
                    return i;
                }
            }
            i += 1;
        }
        B.len()
    }
    const END: usize = find_second_dot();
    // SAFETY: slicing valid UTF-8 at ASCII '.' boundary
    unsafe { std::str::from_utf8_unchecked(std::slice::from_raw_parts(B.as_ptr(), END)) }
};

pub const SEPARATOR_ANNOUNCE: &str = concatcp!("AgentWorld-Announce-", PROTOCOL_VERSION, "\0");
pub const SEPARATOR_HEARTBEAT: &str = concatcp!("AgentWorld-Heartbeat-", PROTOCOL_VERSION, "\0");
pub const SEPARATOR_MESSAGE: &str = concatcp!("AgentWorld-Message-", PROTOCOL_VERSION, "\0");
pub const SEPARATOR_HTTP_REQUEST: &str = concatcp!("AgentWorld-Req-", PROTOCOL_VERSION, "\0");
pub const SEPARATOR_HTTP_RESPONSE: &str = concatcp!("AgentWorld-Res-", PROTOCOL_VERSION, "\0");
pub const SEPARATOR_AGENT_CARD: &str = concatcp!("AgentWorld-Card-", PROTOCOL_VERSION, "\0");
pub const SEPARATOR_KEY_ROTATION: &str = concatcp!("AgentWorld-Rotation-", PROTOCOL_VERSION, "\0");
pub const SEPARATOR_WORLD_STATE: &str = concatcp!("AgentWorld-WorldState-", PROTOCOL_VERSION, "\0");

macro_rules! concatcp {
    ($a:expr, $b:expr, $c:expr) => {{
        const A: &str = $a;
        const B: &str = $b;
        const C: &str = $c;
        const LEN: usize = A.len() + B.len() + C.len();
        const fn build() -> [u8; LEN] {
            let mut buf = [0u8; LEN];
            let a = A.as_bytes();
            let b = B.as_bytes();
            let c = C.as_bytes();
            let mut i = 0;
            while i < a.len() {
                buf[i] = a[i];
                i += 1;
            }
            let mut j = 0;
            while j < b.len() {
                buf[i + j] = b[j];
                j += 1;
            }
            let mut k = 0;
            while k < c.len() {
                buf[i + j + k] = c[k];
                k += 1;
            }
            buf
        }
        // SAFETY: inputs are valid UTF-8 str literals, concatenation is valid UTF-8
        unsafe { std::str::from_utf8_unchecked(&{ const BYTES: [u8; LEN] = build(); BYTES }) }
    }};
}
use concatcp;

/// Derive an agent ID from a base64-encoded Ed25519 public key.
/// Format: `aw:sha256:<hex(sha256(pubkey_bytes))>`
pub fn agent_id_from_public_key(public_key_b64: &str) -> Result<String, CryptoError> {
    let pub_bytes = B64.decode(public_key_b64).map_err(|_| CryptoError::InvalidBase64)?;
    let hash = Sha256::digest(&pub_bytes);
    Ok(format!("aw:sha256:{}", hex::encode(hash)))
}

/// Canonicalize a JSON value: sort object keys recursively, arrays preserved.
pub fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted = serde_json::Map::new();
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for k in keys {
                sorted.insert(k.clone(), canonicalize(&map[k]));
            }
            Value::Object(sorted)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

/// Sign a payload with domain separation.
/// Returns base64-encoded Ed25519 signature.
pub fn sign_with_domain_separator(
    separator: &str,
    payload: &Value,
    signing_key: &SigningKey,
) -> String {
    let canonical_json = serde_json::to_string(&canonicalize(payload)).unwrap();
    let mut message = Vec::with_capacity(separator.len() + canonical_json.len());
    message.extend_from_slice(separator.as_bytes());
    message.extend_from_slice(canonical_json.as_bytes());
    let sig = signing_key.sign(&message);
    B64.encode(sig.to_bytes())
}

/// Verify a domain-separated signature.
pub fn verify_with_domain_separator(
    separator: &str,
    public_key_b64: &str,
    payload: &Value,
    signature_b64: &str,
) -> Result<bool, CryptoError> {
    let canonical_json = serde_json::to_string(&canonicalize(payload)).unwrap();
    let mut message = Vec::with_capacity(separator.len() + canonical_json.len());
    message.extend_from_slice(separator.as_bytes());
    message.extend_from_slice(canonical_json.as_bytes());

    let pub_bytes = B64.decode(public_key_b64).map_err(|_| CryptoError::InvalidBase64)?;
    let verifying_key =
        VerifyingKey::from_bytes(&pub_bytes.try_into().map_err(|_| CryptoError::InvalidKeyLength)?)
            .map_err(|_| CryptoError::InvalidPublicKey)?;
    let sig_bytes = B64.decode(signature_b64).map_err(|_| CryptoError::InvalidBase64)?;
    let signature = ed25519_dalek::Signature::from_bytes(
        &sig_bytes
            .try_into()
            .map_err(|_| CryptoError::InvalidSignatureLength)?,
    );

    Ok(verifying_key.verify(&message, &signature).is_ok())
}

/// Compute SHA-256 content digest in the AWN header format.
pub fn compute_content_digest(body: &str) -> String {
    let hash = Sha256::digest(body.as_bytes());
    format!("sha-256=:{}:", B64.encode(hash))
}

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("invalid base64 encoding")]
    InvalidBase64,
    #[error("invalid key length (expected 32 bytes)")]
    InvalidKeyLength,
    #[error("invalid public key")]
    InvalidPublicKey,
    #[error("invalid signature length (expected 64 bytes)")]
    InvalidSignatureLength,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use serde_json::json;

    fn make_keypair() -> (SigningKey, String) {
        let seed: [u8; 32] = [
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
            24, 25, 26, 27, 28, 29, 30, 31, 32,
        ];
        let signing_key = SigningKey::from_bytes(&seed);
        let pub_b64 = B64.encode(signing_key.verifying_key().as_bytes());
        (signing_key, pub_b64)
    }

    #[test]
    fn test_agent_id_deterministic() {
        let (_, pub_b64) = make_keypair();
        let id1 = agent_id_from_public_key(&pub_b64).unwrap();
        let id2 = agent_id_from_public_key(&pub_b64).unwrap();
        assert_eq!(id1, id2);
        assert!(id1.starts_with("aw:sha256:"));
        assert_eq!(id1.len(), "aw:sha256:".len() + 64);
    }

    #[test]
    fn test_agent_id_different_keys() {
        let (_, pub_b64_1) = make_keypair();
        let seed2: [u8; 32] = [42; 32];
        let key2 = SigningKey::from_bytes(&seed2);
        let pub_b64_2 = B64.encode(key2.verifying_key().as_bytes());
        let id1 = agent_id_from_public_key(&pub_b64_1).unwrap();
        let id2 = agent_id_from_public_key(&pub_b64_2).unwrap();
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_agent_id_invalid_base64() {
        assert!(agent_id_from_public_key("not-valid!!!").is_err());
    }

    #[test]
    fn test_canonicalize_sorts_keys() {
        let input = json!({"b": 2, "a": 1, "c": 3});
        let canonical = canonicalize(&input);
        let s = serde_json::to_string(&canonical).unwrap();
        assert_eq!(s, r#"{"a":1,"b":2,"c":3}"#);
    }

    #[test]
    fn test_canonicalize_nested() {
        let input = json!({"z": {"b": 2, "a": 1}, "a": [3, 1, 2]});
        let canonical = canonicalize(&input);
        let s = serde_json::to_string(&canonical).unwrap();
        assert_eq!(s, r#"{"a":[3,1,2],"z":{"a":1,"b":2}}"#);
    }

    #[test]
    fn test_canonicalize_preserves_array_order() {
        let input = json!([3, 1, 2]);
        let canonical = canonicalize(&input);
        assert_eq!(canonical, json!([3, 1, 2]));
    }

    #[test]
    fn test_canonicalize_primitives() {
        assert_eq!(canonicalize(&json!(42)), json!(42));
        assert_eq!(canonicalize(&json!("hello")), json!("hello"));
        assert_eq!(canonicalize(&json!(true)), json!(true));
        assert_eq!(canonicalize(&json!(null)), json!(null));
    }

    #[test]
    fn test_sign_and_verify_roundtrip() {
        let (signing_key, pub_b64) = make_keypair();
        let payload = json!({"agentId": "aw:sha256:abc", "ts": 1234567890});
        let sig = sign_with_domain_separator(SEPARATOR_HEARTBEAT, &payload, &signing_key);
        let valid =
            verify_with_domain_separator(SEPARATOR_HEARTBEAT, &pub_b64, &payload, &sig).unwrap();
        assert!(valid);
    }

    #[test]
    fn test_wrong_separator_fails() {
        let (signing_key, pub_b64) = make_keypair();
        let payload = json!({"test": true});
        let sig = sign_with_domain_separator(SEPARATOR_ANNOUNCE, &payload, &signing_key);
        let valid =
            verify_with_domain_separator(SEPARATOR_HEARTBEAT, &pub_b64, &payload, &sig).unwrap();
        assert!(!valid);
    }

    #[test]
    fn test_wrong_key_fails() {
        let (signing_key, _) = make_keypair();
        let seed2: [u8; 32] = [42; 32];
        let other_key = SigningKey::from_bytes(&seed2);
        let other_pub = B64.encode(other_key.verifying_key().as_bytes());

        let payload = json!({"test": true});
        let sig = sign_with_domain_separator(SEPARATOR_ANNOUNCE, &payload, &signing_key);
        let valid =
            verify_with_domain_separator(SEPARATOR_ANNOUNCE, &other_pub, &payload, &sig).unwrap();
        assert!(!valid);
    }

    #[test]
    fn test_tampered_payload_fails() {
        let (signing_key, pub_b64) = make_keypair();
        let payload = json!({"test": true});
        let sig = sign_with_domain_separator(SEPARATOR_ANNOUNCE, &payload, &signing_key);
        let tampered = json!({"test": false});
        let valid =
            verify_with_domain_separator(SEPARATOR_ANNOUNCE, &pub_b64, &tampered, &sig).unwrap();
        assert!(!valid);
    }

    #[test]
    fn test_content_digest() {
        let digest = compute_content_digest("hello world");
        assert!(digest.starts_with("sha-256=:"));
        assert!(digest.ends_with(":"));
        let digest2 = compute_content_digest("hello world");
        assert_eq!(digest, digest2);
        let digest3 = compute_content_digest("different");
        assert_ne!(digest, digest3);
    }

    #[test]
    fn test_domain_separator_values() {
        let v = PROTOCOL_VERSION;
        assert_eq!(SEPARATOR_ANNOUNCE, format!("AgentWorld-Announce-{v}\0"));
        assert_eq!(SEPARATOR_HEARTBEAT, format!("AgentWorld-Heartbeat-{v}\0"));
        assert_eq!(SEPARATOR_MESSAGE, format!("AgentWorld-Message-{v}\0"));
        assert_eq!(SEPARATOR_HTTP_REQUEST, format!("AgentWorld-Req-{v}\0"));
        assert_eq!(SEPARATOR_HTTP_RESPONSE, format!("AgentWorld-Res-{v}\0"));
    }

    #[test]
    fn test_canonicalize_key_order_matches_ts() {
        let input = json!({"from": "aw:sha256:abc", "publicKey": "AAAA", "alias": "test", "timestamp": 1000});
        let canonical = canonicalize(&input);
        let s = serde_json::to_string(&canonical).unwrap();
        assert!(s.starts_with(r#"{"alias":"#));
        assert!(s.contains(r#""from":"aw:sha256:abc""#));
    }

    // ── Cross-language compatibility tests (values from TS implementation) ───

    #[test]
    fn test_compat_agent_id_matches_ts() {
        let pub_b64 = "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=";
        let id = agent_id_from_public_key(pub_b64).unwrap();
        assert_eq!(
            id,
            "aw:sha256:65b60673d6ed884bf01c2c222d82ada0740f29ac3355d6a925c81f17f47a27b8"
        );
    }

    #[test]
    fn test_compat_canonicalize_matches_ts() {
        let input = json!({"agentId": "aw:sha256:abc", "ts": 1234567890});
        let canonical = canonicalize(&input);
        let s = serde_json::to_string(&canonical).unwrap();
        assert_eq!(s, r#"{"agentId":"aw:sha256:abc","ts":1234567890}"#);
    }

    #[test]
    fn test_compat_sign_verify_matches_ts() {
        // Same deterministic seed as TS test
        let seed: [u8; 32] = [
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
            24, 25, 26, 27, 28, 29, 30, 31, 32,
        ];
        let signing_key = SigningKey::from_bytes(&seed);
        let pub_b64 = B64.encode(signing_key.verifying_key().as_bytes());
        assert_eq!(pub_b64, "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=");

        let payload = json!({"agentId": "aw:sha256:abc", "ts": 1234567890});
        let sig = sign_with_domain_separator(SEPARATOR_HEARTBEAT, &payload, &signing_key);

        // Sign-then-verify roundtrip (signature includes PROTOCOL_VERSION
        // in the domain separator, so we cannot compare against a static
        // string across version bumps)
        let valid =
            verify_with_domain_separator(SEPARATOR_HEARTBEAT, &pub_b64, &payload, &sig).unwrap();
        assert!(valid);
    }

    #[test]
    fn test_compat_content_digest_matches_ts() {
        let digest = compute_content_digest("hello world");
        assert_eq!(digest, "sha-256=:uU0nuZNNPgilLlLX2n2r+sSE7+N6U4DukIj3rOLvzek=:");
    }
}
