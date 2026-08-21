# HarnessOS Desktop — Instalação e Distribuição (Equipe)

App desktop nativo (Mac/Windows) que envelopa o HarnessOS com:

- **Finder nativo** integrado ("Procurar..." abre NSOpenPanel)
- **Server local embutido** (Bun standalone binary, não precisa instalar Bun)
- **Postgres compartilhado** com o hosted UI (mesmo DB, audit log unificado)
- **WebView nativo** com a mesma UI do `harness-os.pscode.ia.br`

## O Dev precisa

- **Nada**. Só baixar o `.dmg` (Mac) ou `.msi` (Windows), instalar, abrir.

## Distribuição (Paulo)

```bash
# O .dmg fica em:
apps/tauri-shell/src-tauri/target/release/bundle/dmg/HarnessOS_0.1.0_aarch64.dmg

# Envia pelo Slack/email/disco compartilhado pro time.
# Tamanho ~130MB (Tauri + Bun runtime + server + web).
```

## Instalação por Dev

### Mac (Apple Silicon — M1/M2/M3/M4)

1. Baixa `HarnessOS_0.1.0_aarch64.dmg`
2. **Duplo clique** no `.dmg` → abre janela do Finder
3. **Arrasta** o ícone `HarnessOS` pra pasta **Applications**
4. Abre **Applications** → **duplo clique** em HarnessOS
5. Mac vai pedir confirmação na primeira vez (app não assinado) → **"Open"** no dialog
6. Janela 1440x900 abre com a UI carregando (5-10s pro server local iniciar)

### Mac (Intel)

Recompila com `bunx tauri build --target x86_64-apple-darwin` (precisa de Mac Intel — cross-compile do M1 não funciona bem pra x86).

### Windows

1. Baixa `HarnessOS_0.1.0_x64_en-US.msi`
2. **Duplo clique** → wizard de instalação
3. Marca "Install for all users" (ou "Just me")
4. **Finish**
5. Atalho no menu Iniciar → **HarnessOS**

## O que o app faz

- **Cria a janela 1440x900** com a mesma UI do hosted HarnessOS
- **Spawna o server local** (porta 3090) em background
- **Conecta no Postgres remoto** (`213.199.32.229:5432/HarnessOS`) — **mesmo DB que a UI hosted usa**
- **Audit log unificado**: ações feitas no app desktop aparecem no `/console/audit-log` da UI hosted
- **Codebases/demandas/custos/chat**: tudo via server local, persistido no DB compartilhado
- **"Procurar..." no Adicionar projeto** abre o **Finder nativo do Mac** (NSOpenPanel) — pode navegar/criar pastas, seleciona com o path completo

## O que o Dev NÃO precisa

- ❌ Instalar Bun (vem embutido no app)
- ❌ Instalar Docker
- ❌ Clonar o repo `harnessos-v3`
- ❌ Configurar env vars (DATABASE_URL vem hardcoded no app)
- ❌ Rodar nenhum comando de terminal

## Troubleshooting

### "HarnessOS.app is damaged" (Mac)

Mac Gatekeeper reclama de apps não assinados. Solução rápida:

```bash
xattr -cr /Applications/HarnessOS.app
```

Ou: System Settings → Privacy & Security → "Open anyway" (botão aparece depois da 1ª tentativa de abrir).

### Janela abre mas fica em branco / "HarnessOS server failed to start"

Algo crashou no server local. Pra debugar (Mac):

```bash
# Pega os logs do Tauri
log show --predicate 'process == "HarnessOS"' --last 5m
```

Ou clica em **HarnessOS → About HarnessOS** no menu do app (se eu adicionar essa opção).

Solução comum: deletar o app e reinstalar.

### "Adicionar projeto" continua dando 500

Significa que o **server local não conseguiu conectar no Postgres remoto**. Verificar:

```bash
# Do Mac do Dev:
nc -zv 213.199.32.229 5432
```

Se não conectar, é problema de rede (firewall, VPN, etc).

## Próximas builds

Pra regerar o `.dmg` quando o código mudar:

```bash
cd /Users/paulosiqueira/Documents/PS-Code/Projetos/SistemasAgenticos/Archon
bun install

# Compila o server Bun standalone (1-2min)
bun build --compile packages/server/src/index.ts \
  --target=bun-darwin-arm64 \
  --outfile=apps/tauri-shell/src-tauri/bin/harnessos-server-aarch64-apple-darwin

# Builda o Tauri .dmg (5-10min cold, 1-2min warm)
cd apps/tauri-shell
bunx tauri build
```

O `.dmg` final fica em `src-tauri/target/release/bundle/dmg/`.
