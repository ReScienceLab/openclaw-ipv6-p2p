---
"@resciencelab/agent-world-sdk": patch
---

fix(sdk): correct base58 encode/decode for leading-zero byte inputs

`base58Encode([0])` produced `"11"` instead of `"1"` and `base58Decode("1")` produced
`[0, 0]` instead of `[0]`. Fixed by skipping trailing zero digits in the encoder and
rewriting the leading-zero byte handling in the decoder. Not triggered by current
Ed25519 key usage but now correct for general reuse.
