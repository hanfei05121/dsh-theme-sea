#!/usr/bin/env node
/**
 * One-command release for this fork.
 *
 *   node scripts/release.mjs 1.2.6
 *   node scripts/release.mjs --bump patch
 *
 * Steps: sync the version into package.json, extension/manifest.json and
 * package-lock.json, regenerate every install copy, verify the copies match
 * `shared/`, commit, tag and push. The tag matters: another machine installs
 * this theme with `dsh plugin --profile web add
 * 'github:hanfei05121/dsh-theme-sea#vX.Y.Z'`, and a tag is a fixed snapshot -
 * pushing new commits without a new tag will not reach that machine.
 *
 * Flags:
 *   --bump patch|minor|major   derive the next version from package.json
 *   --no-push                  stop after the local commit and tag
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const noPush = args.includes('--no-push')
const bumpIndex = args.indexOf('--bump')
const bump = bumpIndex === -1 ? null : args[bumpIndex + 1]
const explicit = args.find((arg) => /^\d+\.\d+\.\d+$/.test(arg))

const path = (rel) => join(root, rel)
const read = (rel) => readFileSync(path(rel), 'utf8')

function run(command, argv, label) {
  const result = spawnSync(command, argv, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`\n✗ ${label} failed; nothing was pushed.`)
    process.exit(1)
  }
}

function git(...argv) {
  const result = spawnSync('git', ['-C', root, ...argv], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${argv.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return (result.stdout ?? '').trim()
}

function nextVersion(current) {
  const [major, minor, patch] = current.split('.').map(Number)
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`
  return null
}

const pkg = JSON.parse(read('package.json'))
const version = explicit ?? nextVersion(pkg.version)
if (version === null) {
  console.error('Usage: node scripts/release.mjs <x.y.z> | --bump patch|minor|major')
  process.exit(2)
}

const tag = `v${version}`
console.log(`\nReleasing ${pkg.name} ${pkg.version} -> ${version} (${tag})\n`)

if (git('tag', '-l', tag)) {
  console.error(`✗ Tag ${tag} already exists locally; pick another version.`)
  process.exit(1)
}
if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) {
  console.error(`✗ Tag ${tag} already exists on origin; pick another version.`)
  process.exit(1)
}

const dirty = git('status', '--porcelain')
if (dirty) {
  console.log('Working tree has uncommitted changes; they will be included:')
  console.log(dirty.split('\n').map((line) => `  ${line}`).join('\n'))
  console.log('')
}

// 1. version in three places: skip the lock file and `npm ci` fails on CI.
const write = (rel, text) => writeFileSync(path(rel), text)

let manifest = read('extension/manifest.json')
if (!manifest.includes(`"version": "${version}"`)) {
  write('extension/manifest.json', manifest.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`))
  console.log('  updated extension/manifest.json')
}

let lock = read('package-lock.json')
const lockBefore = lock
lock = lock.replace(/("version":\s*)"[^"]+"/, `$1"${version}"`)
lock = lock.replace(
  /("name": "dsh-theme-sea",\s*"version":\s*)"[^"]+"/,
  `$1"${version}"`,
)
if (lock !== lockBefore) {
  write('package-lock.json', lock)
  console.log('  updated package-lock.json')
}

write('package.json', read('package.json').replace(/("version":\s*)"[^"]+"/, `$1"${version}"`))
console.log('  updated package.json')

// 2. regenerate and verify every install copy.
run(process.execPath, [path('scripts/build-runtime.mjs')], 'build-runtime')
run(process.execPath, [path('scripts/build-dsh-bundle.mjs')], 'build-dsh-bundle')
run(process.execPath, [path('scripts/build-runtime.mjs'), '--check'], 'check-runtime')
run(process.execPath, [path('scripts/build-dsh-bundle.mjs'), '--check'], 'check-dsh-bundle')
console.log('  install copies match shared/\n')

// 3. commit, tag, push.
run('git', ['add', '-A'], 'git add')
run('git', ['commit', '-m', `chore: release ${pkg.name} ${version}`], 'git commit')
run('git', ['tag', '-a', tag, '-m', `${pkg.name} ${version}`], 'git tag')

if (noPush) {
  console.log(`\n✓ Committed and tagged ${tag} locally (--no-push).`)
  process.exit(0)
}

run('git', ['push'], 'git push')
run('git', ['push', 'origin', tag], 'git push tag')

console.log(`\n✓ Released ${tag}.`)
console.log(`  Another machine: dsh plugin --profile web add 'github:hanfei05121/dsh-theme-sea#${tag}'`)
