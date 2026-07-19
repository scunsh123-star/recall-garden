# Recall Garden

Recall Garden (忆园) is an Obsidian study system for active recall, spaced repetition, structured Markdown cards, AI-assisted study packs, and note verification.

It is designed for any subject. The plugin does not assume a specific school, exam, profession, or knowledge domain.

## Features

- FSRS-6 spaced-repetition scheduling with configurable retention and review limits.
- Structured eight-section study cards for concepts, comparisons, and applied problems.
- Daily review queues, study calendar, exam countdown, diagnostics, snapshots, and recoverable review history.
- AI-generated study packs containing a 30-second answer, missing sections, cloze questions, a four-option discrimination question, and comparison questions.
- A complete preview of every generated item and the final Markdown before anything is written back.
- Safe managed blocks that preserve handwritten content and existing question-bank answer state.
- AI note verification with saved reports and guarded, per-issue corrections.
- No telemetry, advertisements, or automatic AI requests.

## Card format

New cards use this frontmatter marker:

```yaml
---
type: recall-card
subject: Biology
module: Cell Biology
topic: Photosynthesis
---
```

Recall Garden also recognizes the legacy values `study-card`, `学习卡`, and `名词解释` for backward compatibility.

A review card needs a standard-answer section and a 30-second-answer section. The built-in card creator generates a complete eight-section template.

## Installation

### Community directory

After the plugin is approved, install **Recall Garden** from Obsidian's Community plugins directory.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from a GitHub release whose tag matches the manifest version.
2. Place the files in `<vault>/.obsidian/plugins/recall-garden/`.
3. Reload Obsidian and enable **Recall Garden** under Community plugins.

For pre-directory testing, the repository can also be installed through BRAT.

## AI providers

AI features are disabled by default. Users explicitly choose and configure a provider:

- **DeepSeek API**: uses a user-provided API key stored through Obsidian SecretStorage.
- **ChatGPT Codex device login**: an optional compatibility channel using a plugin-specific OAuth session. This channel uses an upstream interface that is not a stable public OpenAI API and may stop working when the service changes.

No AI provider is contacted during startup, vault scanning, scheduling, ordinary review, or diagnostics. A request is sent only after the user clicks an AI action.

Read [PRIVACY.md](PRIVACY.md) before enabling an AI provider.

## Data safety

- Review data uses Obsidian's plugin data API.
- API keys and OAuth tokens use Obsidian SecretStorage and are excluded from snapshots.
- Stable card IDs preserve review history across file renames.
- Unknown newer data schemas enter read-only protection instead of overwriting data.
- AI write-back uses `Vault.process`, verifies that the source has not changed since preview, and modifies only explicit managed regions or uniquely matched corrections.
- Production releases contain no developer Vault path, local deployment configuration, or user data.

## Development

Requirements: Node.js 20 or newer and npm.

```bash
npm ci
npm test
npm run check
npm run build
```

The build creates a minified `main.js`. Obsidian release assets are:

- `main.js`
- `manifest.json`
- `styles.css`

`main.js` is intentionally not committed to the repository; it is attached to GitHub releases.

## Release policy

- The GitHub release tag must exactly match `manifest.json`'s version, without a `v` prefix.
- Source, lockfile, tests, manifest, `versions.json`, and release notes are committed.
- Built assets are uploaded to the matching GitHub release.
- Schema changes must preserve stable IDs, scheduling history, archived cards, and saved AI questions.

## License

Recall Garden is released under the [MIT License](LICENSE). Third-party attribution is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines. Please report security problems according to [SECURITY.md](SECURITY.md), not through a public issue.
