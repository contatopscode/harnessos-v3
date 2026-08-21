# HarnessOS Desktop — Arquitetura e Decisões

## Contexto

O HarnessOS UI é web (Vite + React em `packages/web`). Roda em 3 modos:

1. **Hospedado na VPS Easypanel** (produção, atual): `https://harness-os.pscode.ia.br` — server Bun, banco Postgres remoto. **Não tem acesso ao filesystem do Mac do usuário** — daí o erro 500 ao tentar "Adicionar projeto" com path local.

2. **Self-hosted Docker no Mac** (alternativa rejeitada): mesma UI, server local. Funciona mas exige deploy distribuído pra cada Dev.

3. **Desktop Tauri** (esta solução): app nativo Mac/Windows que envelopa o mesmo `packages/web/dist`. Tem acesso direto ao fs local via Rust/Tauri commands. Conecta no server (local OU remoto) via API. **Self-service real, sem perder o server centralizado.**

## Arquitetura

```
┌──────────────────────────────────────────────────────────┐
│ Tauri Desktop App (Mac/Win)                              │
│ ┌────────────────────────────────────────────────────┐   │
│ │  WebView (WKWebView / WebView2)                    │   │
│ │  carrega packages/web/dist (mesma UI do hosted)    │   │
│ │                                                    │   │
│ │  IPC: window.__TAURI__.core.invoke(...)            │   │
│ │       ↓                                            │   │
│ │  Rust commands (lib.rs):                           │   │
│ │    pick_directory, pick_file, validate_path,       │   │
│ │    get_app_info, get_env, list_dir                 │   │
│ └────────────────────────────────────────────────────┘   │
└────────────┬─────────────────────────────────────────────┘
             │ HTTPS (cookies Better Auth)
             ▼
┌──────────────────────────────────────────────────────────┐
│ Server (local sidecar OU remoto Easypanel)               │
│                                                          │
│  - REST API + SSE chat                                   │
│  - Audit log: toda ação CRUD/RBAC/login/run dispatch     │
│  - Workflow engine                                       │
│  - FORGE UI (sub-rota)                                   │
└────────────┬─────────────────────────────────────────────┘
             │
             ▼
┌──────────────────────────────────────────────────────────┐
│ Postgres (compartilhado)                                 │
│ 213.199.32.229:5432/HarnessOS                            │
│                                                          │
│  Tabelas: codebases, conversations, sessions,            │
│  workflow_runs, costs, audit_log, demandas, OS, ...      │
└──────────────────────────────────────────────────────────┘
```

### Por que Tauri e não Electron?

- **Bundle 10x menor**: Tauri ~5-10MB vs Electron ~150MB+
- **Memória ~50% menor**: usa WebView do SO, não Chromium embutido
- **Mais seguro**: Rust backend, capabilities granulares (vs Node context no Electron)
- **Bundle cross-platform**: 1 codebase Rust compila Mac/Win/Linux/iOS/Android
- **Backend Rust-first**: ops de fs são nativas (sem overhead JS↔native)

### Por que sidecar local é o futuro (não agora)?

Hoje: app Tauri é "browser nativo" — server Bun roda na VPS (Easypanel), UI aponta pra lá.

Amanhã (sidecar):

- Tauri inicia `bun run --filter @archon/server start` em background
- Server escuta em `127.0.0.1:3090`
- UI aponta `http://localhost:3090`
- Server tem acesso direto ao fs do Mac (mesma máquina)
- DB: ainda aponta pro Postgres remoto (P2=b)

**Por que sidecar é o futuro:** self-contained, offline, fs funciona 100% mesmo sem internet (apenas chat/AI precisa de rede). Tradeoff: app fica mais pesado (server embutido).

**Por que NÃO sidecar agora:** adiciona complexidade de packaging (Bun binary vs Tauri binary vs Tauri commands orquestrando os dois). Primeiro valida UX com "browser nativo", depois migra pra sidecar.

### FORGE e audit log

- **FORGE UI** (`/forge`): continua 100% na VPS. Não muda nada.
- **Audit log**: escrito pelo server. Tanto o app Tauri (via API) quanto o FORGE (via API) escrevem no mesmo `remote_agent_audit_log`. O Console UI mostra a timeline unificada.
- **Disparar RUN / auto-progress**: igual, server é a fonte de verdade.

## Decisões

### D1 — Tauri 2.x (não 1.x)

- 2.x tem permissions granulares (`capabilities/default.json` whitelist explícita)
- Melhor suporte a mobile (futuro)
- Plugin ecosystem maduro

### D2 — Mac + Windows desde o início

- Tauri compila cross-platform com 1 codebase
- Esforço marginal pra adicionar Windows
- Não ficar refatorando depois

### D3 — DB compartilhado (Postgres remoto), não local

- Mesma fonte de verdade entre Tauri e FORGE
- Workflows rodam independente de onde o user tá
- Sem migração de dados entre dev/local/prod

### D4 — Whitelist de env vars (não expor env inteiro)

- UI não vê o env completo (segurança)
- Só o que precisa: `DATABASE_URL`, `PORT`, `HOSTNAME`, `NODE_ENV`, `LOG_LEVEL`
- Adicionar mais sob demanda explícita

### D5 — Plugins nativos (não reinventar)

- `tauri-plugin-dialog` — folder/file picker
- `tauri-plugin-fs` — read file/dir (whitelisted)
- `tauri-plugin-shell` — exec whitelisted commands (git)
- `tauri-plugin-opener` — open URL in default browser
- Tudo com permissões granulares

## Roadmap detalhado

### ✅ DONE (esta sessão)

- [x] Estrutura `apps/tauri-shell/` (monorepo workspace)
- [x] Rust toolchain instalado (1.98)
- [x] Tauri CLI 2.11.4 instalado
- [x] Ícones gerados (32, 64, 128, 128@2x, .icns, .ico)
- [x] `tauri.conf.json` (aponta pro `packages/web/dist`, janela 1440x900)
- [x] `capabilities/default.json` (whitelist de permissões)
- [x] Tauri commands: `pick_directory`, `pick_file`, `validate_path`, `get_app_info`, `get_env`, `list_dir`
- [x] `cargo check` verde
- [x] `tauri build --debug --no-bundle` em progresso

### ⏭️ PRÓXIMO (já planejado)

- [ ] **Wire UI**: helper JS em `packages/web/src/lib/tauri.ts` com fallback browser
- [ ] **Substituir "Procurar..." do New Project** no `CodebasesPage` por `pick_directory`
- [ ] **Smoke test**: criar projeto via UI Tauri apontando pra pasta local

### 🔮 FUTURO

- [ ] **Sidecar Bun server** (server local dentro do app)
- [ ] **Build de produção** (`.dmg` Mac + `.msi` Windows) com code signing
- [ ] **Auto-update** via Tauri updater plugin
- [ ] **File watcher** (Rust `notify` crate → webhook pro server)
- [ ] **Tray icon** + menu de quick actions
- [ ] **Multiple windows** (chat numa janela, codebases em outra)
- [ ] **Linux support** (.deb/.rpm) — fácil com Tauri

## Limitações conhecidas

1. **Cold build Rust é lento** (~3-5min na primeira vez, <30s warm). CI precisa cachear `src-tauri/target/`.
2. **WebView2** no Windows 7/8 não vem por default — usuários antigos precisam instalar manualmente.
3. **Code signing Mac** (~USD 100/ano Apple Developer ID) é necessário pra distribuir fora da App Store sem warning.
4. **Auto-update** precisa de infra (Tauri updater server ou GitHub Releases).
5. **Linux** não foi testado (não é prioridade — Paulo usa Mac + Win).
