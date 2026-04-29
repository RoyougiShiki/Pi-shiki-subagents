#!/usr/bin/env node
/**
 * Migrate OMO (oh-my-openagent) configuration to oh-my-opencode-slim format.
 *
 * Usage:
 *   node scripts/migrate-omo-config.mjs [input-path] [output-path]
 *
 * Defaults:
 *   input:  ~/.config/opencode/oh-my-openagent.json
 *   output: ~/.config/opencode/oh-my-opencode-slim.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const OMO_TO_SLIM_AGENT_MAP = {
  sisyphus: 'orchestrator',
  hephaestus: 'fixer',
  prometheus: 'orchestrator',
  atlas: 'oracle',
  metis: 'oracle',
  momus: 'oracle',
  explore: 'explorer',
  'sisyphus-junior': 'fixer',
}

const OMO_TO_SLIM_CATEGORY_MAP = {
  'visual-engineering': 'designer',
  ultrabrain: 'oracle',
  deep: 'oracle',
  artistry: 'designer',
  quick: 'explorer',
  'unspecified-low': 'explorer',
  'unspecified-high': 'oracle',
  writing: 'librarian',
}

function migrateAgentConfig(omoAgent) {
  const result = {}
  if (omoAgent.model) {
    result.model = Array.isArray(omoAgent.model)
      ? omoAgent.model
      : omoAgent.model
  }
  if (omoAgent.fallback_models) {
    const models = Array.isArray(omoAgent.model)
      ? omoAgent.model
      : [omoAgent.model].filter(Boolean)
    result.model = [...models, ...omoAgent.fallback_models]
  }
  if (omoAgent.variant) result.variant = omoAgent.variant
  return result
}

function migrate(omoConfig) {
  const slimConfig = {
    '$schema': 'https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json',
    preset: omoConfig.presets ? Object.keys(omoConfig.presets)[0] : 'default',
    presets: {},
  }

  if (omoConfig.agents) {
    const preset = {}
    for (const [omoName, omoAgent] of Object.entries(omoConfig.agents)) {
      const slimName = OMO_TO_SLIM_AGENT_MAP[omoName] ?? omoName
      const migrated = migrateAgentConfig(omoAgent)
      if (Object.keys(migrated).length > 0) {
        preset[slimName] = migrated
      }
    }
    slimConfig.presets[slimConfig.preset] = preset
  }

  if (omoConfig.categories) {
    const preset = slimConfig.presets[slimConfig.preset]
    for (const [catName, catConfig] of Object.entries(omoConfig.categories)) {
      const slimAgent = OMO_TO_SLIM_CATEGORY_MAP[catName]
      if (slimAgent && catConfig.model) {
        if (!preset[slimAgent]) preset[slimAgent] = {}
        preset[slimAgent].model = catConfig.model
      }
    }
  }

  return slimConfig
}

const home = homedir()
const inputPath = process.argv[2] || join(home, '.config/opencode/oh-my-openagent.json')
const outputPath = process.argv[3] || join(home, '.config/opencode/oh-my-opencode-slim.json')

if (!existsSync(inputPath)) {
  console.error(`OMO config not found: ${inputPath}`)
  process.exit(1)
}

const omoConfig = JSON.parse(readFileSync(inputPath, 'utf-8'))
const slimConfig = migrate(omoConfig)

const outputDir = dirname(outputPath)
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true })
}

writeFileSync(outputPath, JSON.stringify(slimConfig, null, 2) + '\n', 'utf-8')
console.log(`Migrated: ${inputPath} → ${outputPath}`)
console.log(`Agent mapping:`)
for (const [omoName, slimName] of Object.entries(OMO_TO_SLIM_AGENT_MAP)) {
  if (omoConfig.agents?.[omoName]) {
    console.log(`  ${omoName} → ${slimName}`)
  }
}
