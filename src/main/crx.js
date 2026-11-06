'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

// CRX3 layout:  "Cr24" | version(4) | headerSize(4) | header(headerSize) | zip
// CRX2 layout:  "Cr24" | version(4) | pubKeyLen(4) | sigLen(4) | key | sig | zip
const MAGIC = 0x34327243 // "Cr24"

/** Strip the CRX envelope and return the raw zip buffer. */
function zipFromCrx (buffer) {
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== MAGIC) {
    throw new Error('Not a CRX file (bad magic)')
  }
  const version = buffer.readUInt32LE(4)
  let offset
  if (version === 3) {
    offset = 12 + buffer.readUInt32LE(8)
  } else if (version === 2) {
    offset = 16 + buffer.readUInt32LE(8) + buffer.readUInt32LE(12)
  } else {
    throw new Error(`Unsupported CRX version: ${version}`)
  }
  if (offset >= buffer.length) throw new Error('Corrupt CRX file (header runs past EOF)')
  return buffer.subarray(offset)
}

/** Unpack a zip with whatever the platform provides. */
function unzip (zipFile, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true })
  const attempts = [
    ['unzip', ['-q', '-o', zipFile, '-d', targetDir]],
    ['tar', ['-xf', zipFile, '-C', targetDir]]
  ]
  let lastError = null
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: 'ignore' })
      return
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(`Could not unpack the archive (${lastError && lastError.message})`)
}

/** Electron cannot load .crx files, so unpack it into a directory first. */
function unpackCrx (crxPath, targetDir) {
  const buffer = fs.readFileSync(crxPath)
  const zip = zipFromCrx(buffer)
  const tempZip = path.join(os.tmpdir(), `crx-${process.pid}-${Date.now()}.zip`)
  fs.writeFileSync(tempZip, zip)
  try {
    unzip(tempZip, targetDir)
  } finally {
    try { fs.unlinkSync(tempZip) } catch (_) {}
  }
  if (!fs.existsSync(path.join(targetDir, 'manifest.json'))) {
    throw new Error('Unpacked .crx has no manifest.json at its root')
  }
  return targetDir
}

module.exports = { zipFromCrx, unpackCrx, unzip }
