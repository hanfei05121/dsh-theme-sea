#!/usr/bin/env node
/**
 * Open Sea Skin development watcher.
 *
 *   npm run dev
 *
 * Watches `shared/` and, on every save, rebuilds the generated copies and
 * pushes them into the installed DSH profiles, so the whole loop is:
 *
 *   edit shared/  ->  extension/ + native-dist/ + plugin/ + pages-dist/
 *                 ->  ~/.dsh/profiles/<name>/node_modules/open-sea-skin/
 *                 ->  reload the Harness page
 *
 * No Harness rebuild, no plugin reinstall and no `dsh web` restart are needed:
 * the Host half reads `native-dist/` from disk per request with
 * `cache-control: no-cache`.
 *
 * `dsh plugin add|remove` replaces the installed copy, so keep editing the
 * repository sources - this script owns the copy inside the profile.
 *
 * Environment:
 *   OSS_PROFILE_DIR  sync one explicit open-sea-skin package directory
 *   OSS_NO_SITE=1    skip the pages-dist sync
 */

import { spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEBOUNCE_MS = 150
const stamp = () => new Date().toTimeString().slice(0, 8)
const log = (message) => console.log(`[${stamp()}] ${message}`)

/** Artifacts pushed into an installed profile, relative to the package root. */
const PROFILE_ARTIFACTS = [
  'native-dist/loader.js',
  'native-dist/ocean.js',
  'native-dist/skin.html',
  'native-dist/styles.css',
  'native-dist/vendor',
  'plugin/client.js',
  'plugin/index.js',
]

/** Artifacts pushed into the local GitHub Pages preview, same structure. */
const SITE_ARTIFACTS = ['ocean.js', 'styles.css', 'vendor']

function sameBytes(source, target) {
  try {
    const a = readFileSync(source)
    const b = readFileSync(target)
    return a.equals(b)
  } catch {
    return false
  }
}

function writeIfChanged(source, target, stats) {
  if (sameBytes(source, target)) {
    stats.same += 1
    return
  }
  mkdirSync(dirname(target), { recursive: true })
  try {
    writeFileSync(target, readFileSync(source))
    stats.wrote += 1
  } catch (error) {
    stats.failed += 1
    log(`  ! could not write ${target} (${error.code ?? error.message})`)
  }
}

function syncTree(sourceDir, targetDir, stats) {
  for (const entry of readdirSync(sourceDir)) {
    const source = join(sourceDir, entry)
    const target = join(targetDir, entry)
    if (statSync(source).isDirectory()) syncTree(source, target, stats)
    else writeIfChanged(source, target, stats)
  }
}

/** Back up an installed file once, so the profile can be restored by hand. */
function backupOnce(profileRoot, packageDir, artifact) {
  const target = join(packageDir, artifact)
  if (!existsSync(target)) return
  const backup = join(profileRoot, '.oss-dev-backup', 'open-sea-skin', artifact)
  if (existsSync(backup)) return
  mkdirSync(dirname(backup), { recursive: true })
  cpSync(target, backup, { recursive: true })
}

/** Installed directory names this watcher recognises inside a profile. */
const PACKAGE_DIRS = ['dsh-theme-sea', 'open-sea-skin']

function discoverProfiles() {
  const explicit = process.env.OSS_PROFILE_DIR
  if (explicit) return [resolve(explicit)]
  const base = join(homedir(), '.dsh', 'profiles')
  if (!existsSync(base)) return []
  const found = []
  for (const name of readdirSync(base)) {
    for (const dir of PACKAGE_DIRS) {
      const packageDir = join(base, name, 'node_modules', dir)
      if (existsSync(join(packageDir, 'package.json'))) found.push(packageDir)
    }
  }
  return found
}

function profileRootOf(packageDir) {
  return dirname(dirname(packageDir))
}

function build() {
  for (const script of ['build-runtime.mjs', 'build-dsh-bundle.mjs']) {
    const result = spawnSync(process.execPath, [join(root, 'scripts', script)], {
      cwd: root,
      stdio: 'inherit',
    })
    if (result.status !== 0) {
      log(`build failed in ${script}; keeping the watcher alive`)
      return false
    }
  }
  return true
}

function sync() {
  const stats = { wrote: 0, same: 0, failed: 0 }
  const profiles = discoverProfiles()

  for (const packageDir of profiles) {
    for (const artifact of PROFILE_ARTIFACTS) backupOnce(profileRootOf(packageDir), packageDir, artifact)
  }
  for (const packageDir of profiles) {
    for (const artifact of PROFILE_ARTIFACTS) {
      const source = join(root, artifact)
      if (!existsSync(source)) continue
      if (statSync(source).isDirectory()) syncTree(source, join(packageDir, artifact), stats)
      else writeIfChanged(source, join(packageDir, artifact), stats)
    }
  }

  const siteStats = { wrote: 0, same: 0, failed: 0 }
  const site = join(root, 'pages-dist')
  if (!process.env.OSS_NO_SITE && existsSync(site)) {
    for (const artifact of SITE_ARTIFACTS) {
      const source = join(root, artifact)
      if (!existsSync(source)) continue
      if (statSync(source).isDirectory()) syncTree(source, join(site, artifact), siteStats)
      else writeIfChanged(source, join(site, artifact), siteStats)
    }
  }

  const parts = []
  if (profiles.length === 0) parts.push('no DSH profile found - repo artifacts only')
  else parts.push(`${stats.wrote} file(s) into ${profiles.length} profile(s)`)
  if (siteStats.wrote > 0) parts.push(`${siteStats.wrote} file(s) into pages-dist`)
  const unchanged = stats.same + siteStats.same
  if (unchanged > 0) parts.push(`${unchanged} unchanged`)
  if (stats.failed + siteStats.failed > 0) parts.push(`${stats.failed + siteStats.failed} FAILED`)
  log(parts.join(' · '))
}

/** Content fingerprints, so spurious watch events never trigger a rebuild. */
function fingerprintTree(directory) {
  const map = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      const info = statSync(path)
      if (info.isDirectory()) walk(path)
      else map.set(relative(root, path), `${info.mtimeMs}:${info.size}`)
    }
  }
  walk(directory)
  return map
}

function sameFingerprints(previous, next) {
  if (!previous || previous.size !== next.size) return false
  for (const [file, stamp] of previous) {
    if (next.get(file) !== stamp) return false
  }
  return true
}

let baseline = null

function refresh(reason, force = false) {
  const next = fingerprintTree(join(root, 'shared'))
  if (!force && sameFingerprints(baseline, next)) {
    // Windows reports directory churn from the indexer and antivirus scanners;
    // ignore anything that did not actually change a source file.
    if (reason) log(`ignored, nothing changed: ${reason}`)
    return
  }
  baseline = next
  if (reason) log(`changed: ${reason}`)
  if (!build()) return
  sync()
  log('ready - reload the Harness page')
}

function startWatching(directory) {
  try {
    return [watch(directory, { recursive: true }, (_event, filename) => queue(filename))]
  } catch {
    const watchers = [watch(directory, (_event, filename) => queue(filename))]
    for (const entry of readdirSync(directory)) {
      const child = join(directory, entry)
      if (statSync(child).isDirectory()) {
        watchers.push(watch(child, { recursive: true }, (_event, filename) => queue(filename)))
      }
    }
    log('recursive watch unavailable; watching directories individually')
    return watchers
  }
}

let timer = null
const pending = new Set()

function queue(filename) {
  if (filename) pending.add(String(filename))
  clearTimeout(timer)
  timer = setTimeout(() => {
    const names = [...pending].sort()
    pending.clear()
    refresh(names.length > 2 ? `${names.slice(0, 2).join(', ')} (+${names.length - 2})` : names.join(', '))
  }, DEBOUNCE_MS)
}

const profiles = discoverProfiles()
console.log('')
log('open-sea-skin dev watch')
log(`source: ${join(root, 'shared')}`)
if (profiles.length === 0) {
  log('target: no installed DSH profile found; repo artifacts only')
  log('        install once with `dsh plugin --profile web add open-sea-skin` to sync a profile')
} else {
  for (const packageDir of profiles) log(`target: ${packageDir}`)
}
log('edit a file under shared/ and reload the Harness page; Ctrl+C stops the watcher')
console.log('')

const watchers = startWatching(join(root, 'shared'))
refresh('initial sync', true)

function shutdown() {
  clearTimeout(timer)
  for (const watcher of watchers) watcher.close()
  log('watcher stopped')
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
