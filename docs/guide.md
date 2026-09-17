# Guide rapide — coding-tools

Boîte à outils locale pour qu'un LLM (ChatGPT via Desktop Commander, ou tout client MCP) puisse
**chercher, lire, patcher, tester et relire les diffs** d'un repo sans réécrire des fichiers entiers.

Référence complète : [README.md](../README.md).

## Installation

```bash
brew install ripgrep          # recommandé (sinon recherche plus lente en Node)
cd /Users/jide/Projects/coding-tools
pnpm install && pnpm build
pnpm link --global            # installe `coding-tools` et `coding-tools-mcp`
```

Après une modification du code : `pnpm build` (le lien global pointe sur `dist/`).

## Sécurité en une phrase

Tous les chemins doivent être (après résolution des `..` et des symlinks) dans un dossier autorisé,
par défaut `/Users/jide/Projects`. Pour en ajouter :

```bash
export CODING_TOOLS_ROOTS=/Users/jide/Projects:/tmp/coding-work
```

`exec` lance de vraies commandes shell : seul le `cwd` est contrôlé.

## La boucle de travail

| Étape      | Commande                                                                     |
| ---------- | ---------------------------------------------------------------------------- |
| Inspecter  | `coding-tools git-status --cwd $REPO`                                        |
| Structure  | `coding-tools list-tree --path $REPO --depth 2`                              |
| Chercher   | `coding-tools search --cwd $REPO --query createGame --glob '*.ts'`           |
| Lire       | `coding-tools read-file --path $REPO/src/game.ts --offset 100 --limit 80`    |
| Patcher    | `coding-tools apply-patch --cwd $REPO < /tmp/change.patch`                   |
| Relire     | `coding-tools git-diff --cwd $REPO`                                          |
| Tester     | `coding-tools exec --cwd $REPO --command "pnpm test"`                        |
| Comparer   | `coding-tools git-show --cwd $REPO --ref HEAD~1 --path src/game.ts`          |

Ajouter `--json` pour une sortie parsable :

```json
{ "ok": true,  "result": { ... } }
{ "ok": false, "error": { "code": "PATCH_CONTEXT_MISMATCH", "message": "...", "details": { ... } } }
```

## Écrire un patch

Format recommandé :

```diff
*** Begin Patch
*** Update File: src/game.ts
@@
 export function createGame() {
-  return null;
+  return new Game();
 }
*** Add File: src/game.test.ts
+import { createGame } from "./game";
*** Delete File: src/old.ts
*** End Patch
```

- Lignes : ` ` contexte, `-` supprimée, `+` ajoutée. Mettre 1 à 3 lignes de contexte.
- `@@ function foo` : positionne le hunk après la ligne contenant ce texte (utile si le contexte est répété).
- `*** Move to: nouveau/chemin.ts` juste après `*** Update File:` pour renommer.
- Un `git diff` / `diff -u` classique marche aussi.
- `--dry-run` valide sans écrire.
- Tout ou rien : si un seul hunk ne correspond pas, aucun fichier n'est modifié.

Via JSON (pratique quand le patch est construit par un agent) :

```bash
echo '{"cwd":"/Users/jide/Projects/foo","patch":"*** Begin Patch\n...\n*** End Patch"}' \
  | coding-tools apply-patch --json
```

## Lancer des commandes

```bash
coding-tools exec --cwd $REPO --command "pnpm test" --timeout 300000
coding-tools run-checks --cwd $REPO --command "pnpm typecheck" --command "pnpm test"
```

- Un code de sortie ≠ 0 n'est pas une erreur de l'outil : lire `exitCode`.
- Timeout (défaut 120 s) : le process et ses enfants sont tués, `timedOut: true`.
- Sortie trop grosse : début + fin conservés, `truncated: true`.

## MCP

Dans la config du client MCP :

```json
{
  "mcpServers": {
    "local-coding-tools": {
      "command": "coding-tools-mcp",
      "env": { "CODING_TOOLS_ROOTS": "/Users/jide/Projects" }
    }
  }
}
```

Tools : `read_file`, `list_tree`, `search`, `apply_patch`, `exec`, `run_checks`, `git_status`, `git_diff`, `git_show`.
Mêmes paramètres que le JSON du CLI.

## Erreurs fréquentes

| Code                        | Cause / solution                                                   |
| --------------------------- | ------------------------------------------------------------------ |
| `PATH_OUTSIDE_ALLOWED_ROOT` | Chemin hors des roots → ajuster `CODING_TOOLS_ROOTS`               |
| `PATH_RELATIVE_WITHOUT_CWD` | Chemin relatif sans `cwd` (MCP) → passer `cwd` ou un chemin absolu |
| `PATCH_CONTEXT_MISMATCH`    | Le fichier a changé → relire avec `read-file` et refaire le patch  |
| `PATCH_INVALID`             | Format de patch incorrect, ou `Add File` sur un fichier existant   |
| `NOT_A_GIT_REPOSITORY`      | `cwd` n'est pas dans un repo git                                   |

Debug : `DEBUG=coding-tools:* coding-tools ...` affiche les stack traces sur stderr.
