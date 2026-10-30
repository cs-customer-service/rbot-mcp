# rbot-mcp

Servidor MCP (stdio) do RBot. Expõe as rotas de usuário do cs-services com a sessão de um usuário. Só o login (email e senha) é necessário.

## Instalação

```bash
cd rbot-mcp
npm install
```

Configuração no cliente MCP (Kiro, Claude Desktop, Arara Code):

```json
{
  "mcpServers": {
    "rbot": {
      "command": "node",
      "args": ["/caminho/para/rbot-mcp/src/index.js"],
      "env": { "RBOT_EMAIL": "voce@empresa.com", "RBOT_PASSWORD": "sua-senha" }
    }
  }
}
```

Sem `RBOT_EMAIL` e `RBOT_PASSWORD`, chame a ferramenta `rbot_login` com email e senha. Nesse caso a senha não fica guardada, e quando a sessão expira é preciso entrar de novo. Para conta com verificação em duas etapas, chame `rbot_login` de novo só com `twoFactorCode`.

| Variável | Padrão | Uso |
|---|---|---|
| `RBOT_EMAIL`, `RBOT_PASSWORD` | vazio | Login automático e renovação da sessão |
| `RBOT_API_URL` | `https://api.rbot.com.br/cs-services` | Sandbox: `https://sandbox-api.rbot.com.br/cs-services` |
| `RBOT_ADMIN_URL` | `https://gestor.rbot.com.br` | Painel de onde vem a chave pública. Sandbox: `https://sandbox-gestor.rbot.com.br` |
| `RBOT_PUBLIC_KEY` | descoberta no painel | `NEXT_PUBLIC_LOCAL_STORAGE_KEY` do cs-admin, se a descoberta falhar |
| `RBOT_TIMEOUT_MS` | 60000 | Tempo limite por requisição |
| `RBOT_MAX_RESPONSE_BYTES` | 2097152 | Limite de leitura da resposta |
| `RBOT_MAX_OUTPUT_CHARS` | 60000 | Limite do texto devolvido ao modelo |

## Ferramentas

- `rbot_login`, `rbot_logout`, `rbot_session`: sessão.
- `rbot_describe`: lista rotas (`search`) ou mostra o schema de entrada de uma operação (`operation`).
- Uma ferramenta por módulo do cs-services (`rbot_crm`, `rbot_billing`, `rbot_conversations`, `rbot_rbooks`...). O argumento `operation` escolhe a rota, por exemplo `"POST /crm/deals"`. `params` preenche os `:parâmetros` do caminho, `query` vai na URL e `body` vai no corpo.

O catálogo (`src/catalog.json`) tem 306 rotas de 37 módulos, das quais 284 viram operações. Ficam de fora as rotas `/internal` (token de serviço), `/devops`, `/app-login`, os webhooks da Meta, da Evolution e do login externo, a rota de API key de disparos (`/expose/v1/messages/send`) e as de sessão que têm ferramenta própria (login, 2FA, refresh e logout).

## Segurança

- O token da sessão fica só na memória do processo e não aparece na saída das ferramentas. Nada é gravado em disco.
- Só rotas do catálogo podem ser chamadas. O caminho é montado a partir do catálogo, e os parâmetros são codificados. Valores vazios, `.`, `..`, barras e caracteres de controle são recusados.
- As URLs base precisam usar `https` (só `localhost` e `127.0.0.1` aceitam `http`) e não podem conter credenciais. Redirecionamentos da API são recusados.
- Os corpos são cifrados no formato do painel (AES do CryptoJS com a chave pública do cs-admin). Isso só cumpre o protocolo do cs-services, porque a chave é pública. A proteção real é o HTTPS.
- As permissões continuam no cs-services: o usuário só alcança o que o papel e as permissões dele permitem.
- A chave pública é buscada só em scripts do mesmo domínio do painel.

## Atualizar o catálogo

Com o repositório cs-services ao lado (`../cs-services`) ou em `RBOT_SERVICES_DIR`:

```bash
npm run catalog
npm test
```

O teste de catálogo falha se `src/catalog.json` estiver desatualizado em relação às rotas do cs-services.
