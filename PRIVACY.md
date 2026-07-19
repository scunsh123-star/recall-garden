# Privacy

Recall Garden is local-first and contains no telemetry, advertising, analytics, or background network activity.

## Local data

The plugin scans only the Vault folder selected in its settings. Review state, scheduling history, saved questions, and plugin preferences are stored through Obsidian's plugin data API. Verification reports and optional backups are stored inside the user's Vault.

OAuth tokens and API keys are stored through Obsidian SecretStorage. They are not included in exported Recall Garden snapshots.

## AI requests

AI is disabled by default. Network requests occur only after the user explicitly starts an AI action.

- Single-question generation sends the active card's title and study answers.
- AI study-pack generation sends the active Markdown note after removing Recall Garden managed learning and question-bank blocks.
- AI note verification sends the active Markdown note after removing managed blocks.
- Provider authentication and model-list requests occur only when the user opens the relevant controls and starts those actions.

Depending on the user's selected provider, data is sent to DeepSeek or to the ChatGPT Codex service. Those services process requests according to their own terms and privacy policies. Users should not send confidential, regulated, or personally identifying notes unless they have independently confirmed that their provider and account are appropriate for that data.

## External access

The plugin does not read files outside the active Obsidian Vault. It does not access browser history, other applications' credentials, the Codex CLI, or unrelated Vaults.

## Deletion

Disabling or uninstalling the plugin stops all plugin activity. Users can remove local plugin data through Obsidian's plugin folder and can delete generated reports or backups from the Vault like ordinary files.
