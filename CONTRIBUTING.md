# Contributing

Contributions are welcome through GitHub issues and pull requests.

## Development checks

```bash
npm ci
npm test
npm run check
npm run build
```

Add a failing test before changing behavior. Keep file writes scoped to Recall Garden managed regions, preserve existing data schemas, and never place credentials, user notes, local Vault paths, or generated `data.json` files in fixtures or commits.

Release builds must use a SemVer tag that exactly matches `manifest.json` and must attach `main.js`, `manifest.json`, and `styles.css` to the GitHub release.
