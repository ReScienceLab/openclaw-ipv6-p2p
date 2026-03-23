#!/usr/bin/env node
// Post-version hook: sync version + gateway URL from package.json → all derived files
import { readFileSync, writeFileSync } from 'fs'

const { version, gateway } = JSON.parse(readFileSync('package.json', 'utf8'))
const gatewayUrl = gateway?.url

const plugin = JSON.parse(readFileSync('openclaw.plugin.json', 'utf8'))
plugin.version = version
writeFileSync('openclaw.plugin.json', JSON.stringify(plugin, null, 2) + '\n')

let skill = readFileSync('skills/awn/SKILL.md', 'utf8')
skill = skill.replace(/^version: .*/m, `version: "${version}"`)
writeFileSync('skills/awn/SKILL.md', skill)

const sdkPkg = JSON.parse(readFileSync('packages/agent-world-sdk/package.json', 'utf8'))
sdkPkg.version = version
writeFileSync('packages/agent-world-sdk/package.json', JSON.stringify(sdkPkg, null, 2) + '\n')

if (gatewayUrl) {
  let indexTs = readFileSync('src/index.ts', 'utf8')
  indexTs = indexTs.replace(/(process\.env\.GATEWAY_URL \?\? ")[^"]*"/, `$1${gatewayUrl}"`)
  writeFileSync('src/index.ts', indexTs)

  let clientJs = readFileSync('web/client.js', 'utf8')
  clientJs = clientJs.replace(/const GATEWAY = [^\n]*;/, `const GATEWAY = window.GATEWAY_URL || "${gatewayUrl}";`)
  writeFileSync('web/client.js', clientJs)

  let docsHtml = readFileSync('docs/index.html', 'utf8')
  docsHtml = docsHtml.replace(/(<input id="gateway-url" value=")[^"]*"/, `$1${gatewayUrl}"`)
  writeFileSync('docs/index.html', docsHtml)
}

console.log(`Synced version ${version} → openclaw.plugin.json, skills/awn/SKILL.md, packages/agent-world-sdk/package.json${gatewayUrl ? `, src/index.ts, web/client.js, docs/index.html (gatewayUrl: ${gatewayUrl})` : ''}`)
