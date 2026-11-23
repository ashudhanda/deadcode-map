'use strict';

/**
 * Project configuration loader (`deadcode-map.config.json` / `.deadcode-maprc.json`).
 *
 * Supported schema:
 * {
 *   "entries": ["src/worker.js", "scripts/custom-runner.ts"],
 *   "ignore": ["generated/", "\\.gen\\.ts$"],
 *   "keepExports": ["registerPlugin"],
 *   "keepNames": ["onBoot"],
 *   "keepDecorators": ["CustomRoute"],
 *   "keepClassAnnotations": ["CustomComponent"],
 *   "includeFixtures": false,
 *   "noGitignore": false,
 *   "javaSafe": false,
 *   "minConfidence": "review",
 *   "failOn": "safe",
 *   "testCommand": "npm test"
 * }
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILES = ['deadcode-map.config.json', '.deadcode-maprc.json'];

function loadConfig(root, explicitPath) {
  const absRoot = path.resolve(root);
  let configPath = null;

  if (explicitPath) {
    configPath = path.resolve(explicitPath);
    if (!fs.existsSync(configPath)) {
      throw new Error(`config file not found: ${configPath}`);
    }
  } else {
    for (const name of DEFAULT_CONFIG_FILES) {
      const cand = path.join(absRoot, name);
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        configPath = cand;
        break;
      }
    }
  }

  if (!configPath) {
    return { path: null, raw: null, config: {} };
  }

  let raw;
  let parsed;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid config file ${configPath}: ${e.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config file ${configPath} must export a JSON object`);
  }

  return { path: configPath, raw, config: parsed };
}

/**
 * Build a synthetic framework pack from project config custom keep rules so
 * they flow seamlessly through loadFrameworks / confidence grading.
 */
function configToFrameworkPack(config, configPath) {
  if (!config) return null;
  const keepExports = Array.isArray(config.keepExports) ? config.keepExports : [];
  const keepNames = Array.isArray(config.keepNames) ? config.keepNames : [];
  const keepDecorators = Array.isArray(config.keepDecorators) ? config.keepDecorators : [];
  const keepClassAnnotations = Array.isArray(config.keepClassAnnotations) ? config.keepClassAnnotations : [];
  const keepFiles = Array.isArray(config.keepFiles) ? config.keepFiles : [];

  if (!keepExports.length && !keepNames.length && !keepDecorators.length && !keepClassAnnotations.length && !keepFiles.length) {
    return null;
  }

  return {
    _file: configPath ? path.basename(configPath) : 'deadcode-map.config.json',
    description: 'Project config custom rules',
    entryPatterns: [],
    keepFiles,
    keepExports,
    keepNames,
    keepDecorators,
    keepClassAnnotations,
  };
}

module.exports = { DEFAULT_CONFIG_FILES, loadConfig, configToFrameworkPack };
