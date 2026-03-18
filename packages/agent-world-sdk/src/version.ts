import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const pkg = require("../package.json")
export const PROTOCOL_VERSION: string = pkg.version
