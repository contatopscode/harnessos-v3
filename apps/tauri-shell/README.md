# HarnessOS Desktop (Tauri 2 shell)

Aplicativo **nativo Mac + Windows** que envelopa a UI web do HarnessOS (`packages/web`) numa janela nativa, com **acesso direto ao filesystem local** via Tauri commands. Resolve o problema do "Adicionar projeto" da UI remota, que falhava porque o server na VPS não enxerga as pastas do Mac do usuário.

## O que é e o que NÃO é

| | O que FAZ | O que NÃO faz |
|---|---|---|
| **Envelopa o web build** | Mostra a mesma UI do HarnessOS (`packages/web/dist`) numa janela nativa (WebView) | Substitui a UI — é o mesmo código |
| **Folder picker nativo** | Botão "Procurar..." abre o NSOpenPanel (Mac) ou IFileOpenDialog (Windows) | Não é mais o file input HTML limitado |
| **Valida paths locais** | Rust check se o path existe, é dir, é file, canonicaliza | Não sincroniza arquivos com a VPS sozinho |
| **Lê env vars** | Whitelist de `DATABASE_URL`, `PORT`, etc. | Não expor o env inteiro |
| **FORGE + audit log** | Continuam na VPS Easypanel, gravando no mesmo Postgres | Não são duplicados localmente |
| **DB compartilhado** | `DATABASE_URL` aponta pro Postgres da VPS, ambos leem/escrevem | Cada cliente pode ter DB próprio |

**Resumindo**: o app Tauri é um "browser nativo + bridge de fs" pra UI do HarnessOS. O server pode estar local (sidecar, futuro) ou remoto (VPS, atual). O FORGE continua 100% na VPS.

## Pré-requisitos

| Ferramenta | Versão | Como instalar |
|---|---|---|
| **Bun** | 1.3+ | `curl -fsSL https://bun.sh/install \| bash` |
| **Rust** | 1.77+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **XCode CLT** (Mac) | latest | `xcode-select --install` |
| **WebView2** (Win) | latest | pré-instalado no Win 10+ |

## Setup

```bash
# 1. Já tá no monorepo, só instalar deps (Bun workspaces resolve)
cd /Users/paulosiqueira/Documents/PS-Code/Projetos/SistemasAgenticos/Archon
bun install

# 2. Instalar Tauri CLI (já tá no package.json devDep)
bun install

# 3. (Opcional) Regenerar ícones se você mudar o source
cd apps/tauri-shell
bunx tauri icon src-tauri/icons/source.png
```

## Como rodar (dev)

```bash
cd /Users/paulosiqueira/Documents/PS-Code/Projetos/SistemasAgenticos/Archon/apps/tauri-shell
bun run dev
# ou
bunx tauri dev
```

O que acontece:
1. Tauri roda `bun run --filter @archon/web dev` (Vite em `localhost:5173`)
2. Espera o Vite estar pronto
3. Compila o binário Rust (cold ~3-5min, warm <30s)
4. Abre uma janela nativa 1440x900 com o título "HarnessOS"
5. A janela carrega `http://localhost:5173` (HMR funciona)

## Como buildar (produção)

```bash
cd apps/tauri-shell

# Mac (.app + .dmg)
bun run build

# Só o binário (sem .dmg, mais rápido pra testar)
bunx tauri build --no-bundle

# Mac universal (Intel + Apple Silicon)
bunx tauri build --target universal-apple-darwin
```

O bundle vai pra `src-tauri/target/release/bundle/`:
- `macos/HarnessOS.app` — app bundle
- `dmg/HarnessOS_0.1.0_*.dmg` — instalador
- `exe/HarnessOS.exe` (Windows) — quando buildar no Windows

## Tauri commands disponíveis pra UI

A UI chama via `window.__TAURI__.core.invoke('nome_do_command', { args })`:

| Command | Args | Returns | O que faz |
|---|---|---|---|
| `pick_directory` | — | `string \| null` | Folder picker nativo. Retorna path absoluto ou `null` se cancelou. |
| `pick_file` | `{title?, filters?}` | `string \| null` | File picker nativo com filtros opcionais. |
| `validate_path` | `{path}` | `PathInfo` | Check existence + canonicalize. |
| `get_app_info` | — | `AppInfo` | Versão, platform, arch, webview URL, is_dev. |
| `get_env` | `{key}` | `string \| null` | Whitelist de env vars (DATABASE_URL, PORT, etc). |
| `list_dir` | `{path}` | `DirEntry[]` | Lista entries de um dir (dirs primeiro, depois alpha). |

## Helper JS (recomendado pra UI)

A UI precisa detectar se tá dentro do Tauri ou num browser normal (pra dev). Crie um helper em `packages/web/src/lib/tauri.ts`:

```typescript
const isTauri = '__TAURI__' in window;

export async function pickDirectory(): Promise<string | null> {
  if (isTauri) {
    return await window.__TAURI__.core.invoke('pick_directory');
  }
  // Fallback: web (sempre retorna null, força usar text input)
  return null;
}
```

## Stack

- **Tauri 2.11** (Rust 1.98) — shell nativo, IPC via commands
- **WebView** (Mac: WKWebView / Win: WebView2) — renderiza `packages/web/dist`
- **Plugins**: dialog (folder picker), fs (path ops), shell (exec whitelisted), opener (URLs externas)
- **Capabilities** (Tauri 2 permissions): só `dialog:default` + `fs:allow-read-text-file` + `shell:allow-execute[git]` por default

## Roadmap

- [x] Estrutura base + Tauri CLI + Rust toolchain
- [x] Folder picker nativo (macOS NSOpenPanel via tauri-plugin-dialog)
- [x] Path validation + canonicalize
- [x] Env var whitelist (DATABASE_URL, etc)
- [x] Dir listing (pra futuro file browser no UI)
- [ ] **Sidecar Bun server** (server roda dentro do app, sem depender da VPS)
- [ ] **Build de produção** (.dmg Mac + .msi Windows)
- [ ] **Auto-update** (Tauri updater plugin)
- [ ] **Code signing** (Apple Developer ID + Windows Authenticode)
- [ ] **File watcher** (Rust `notify` crate, manda pro server via API)
- [ ] **Tray icon** (app fica no menu bar, quick actions)
- [ ] **Multiple windows** (chat em uma janela, codebases em outra)

Veja `DESKTOP.md` pra arquitetura completa e decisões de design.
