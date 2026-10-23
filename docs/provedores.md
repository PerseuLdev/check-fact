# Provedores e autenticação — pesquisa de 19/10/2026

Escopo: integrar inferência e pesquisa ao Verifica existente. Não instalar um MCP ou um conector de uso geral. A pesquisa não encontrou uma ferramenta conectada de inferência Claude/Gemini que pudesse substituir o backend do aplicativo.

## Google Gemini — login simplificado indisponível

A seleção de JSON foi retirada do fluxo principal. A interface informa que a conexão simplificada está em atualização, mantém o botão desabilitado e não expõe uma tentativa incompatível como funcional. O modo API por projeto próprio está recolhido na configuração avançada.

Teste real de 19/10/2026: o Gemini CLI 0.55.1 inicializa ACP e anuncia oauth-personal, mas o serviço rejeita a autenticação com "This client is no longer supported for Gemini Code Assist for individuals". O anúncio oficial confirma o encerramento para contas pessoais em 18/06/2026. A fachada do servidor bloqueia este caminho; testes unitários do adaptador experimental não comprovam disponibilidade do serviço.

O Antigravity CLI instalado retornou modelos, mas uma inferência mínima terminou por timeout. Ele não foi integrado ao motor. A implementação de um login simples utilizável ainda está pendente.

- https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/
- https://www.antigravity.google/docs/cli/headless/

## Google Gemini — modo API avançado

OAuth oficial para a **Gemini API**, com projeto do Google Cloud, API Generative Language habilitada, tela de consentimento e cliente do tipo **Desktop app**. Não concede uso da assinatura do aplicativo Gemini. As cotas, disponibilidade e eventual cobrança são as do projeto/API; o aplicativo não habilita faturamento.

Aquisição: Google Cloud → Google Auth platform → Audience (adicionar a própria conta como usuário de teste quando aplicável) → Clients → Create client → Desktop app → baixar JSON. O JSON contém `installed.client_id`, `client_secret` e `project_id`. Será importado pela interface local e guardado com DPAPI no Windows, fora do repositório. Não enviar o arquivo pelo chat. Endpoints presentes no arquivo são ignorados: apenas os endpoints oficiais fixos são usados.

Endpoints pesquisados:

- Autorização: `https://accounts.google.com/o/oauth2/v2/auth`, authorization code + PKCE S256 + state, consentimento offline.
- Troca/renovação: `POST https://oauth2.googleapis.com/token`, formulário URL-encoded.
- Revogação: `POST https://oauth2.googleapis.com/revoke`, token no corpo.
- API: `https://generativelanguage.googleapis.com/v1beta`, `Authorization: Bearer <access_token>` e `x-goog-user-project: <project_id>`.
- Catálogo: `GET /models`, `models[].name`, `displayName`, `supportedGenerationMethods`, `nextPageToken`.
- Inferência: `POST /models/<id>:generateContent`, `contents`, `systemInstruction`, `generationConfig.responseMimeType`/`responseJsonSchema`. Pesquisa nativa por `tools:[{googleSearch:{}}]`; proveniência em `candidates[].groundingMetadata.groundingChunks[].web.uri`.

O quickstart oficial utiliza os escopos `https://www.googleapis.com/auth/cloud-platform` e `https://www.googleapis.com/auth/generative-language.retriever`. O aplicativo não chama APIs de Drive, Gmail ou outras APIs. O token pode ser renovado em série e é revogado ao desconectar quando o serviço confirmar.

Para não depender da combinação de ferramentas e JSON estruturado em todos os modelos, a checagem faz pesquisa e formatação em chamadas separadas. A formatação recebe somente o texto pesquisado e as fontes registradas; URLs produzidas apenas no texto não se tornam evidência. Um catálogo não garante acesso à geração ou ao Google Search. Uma resposta bloqueada, incompleta ou sem grounding não vira um veredito factual.

Fontes oficiais lidas:

- https://ai.google.dev/gemini-api/docs/oauth
- https://developers.google.com/identity/protocols/oauth2/native-app
- https://ai.google.dev/api/generate-content
- https://ai.google.dev/gemini-api/docs/google-search
- https://ai.google.dev/gemini-api/docs/structured-output
- https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta (schema REST consultado: generateContent, GenerationConfig, Tool e GroundingMetadata).

## Claude

A documentação oficial não permite oferecer login Claude.ai em aplicações próprias de terceiros nem intermediar credenciais/tokens da assinatura. O OAuth de workload da Claude API é uma federação entre sistemas, não um botão para usar a assinatura pessoal. Não copiar client IDs do Claude Code, ler tokens de outros aplicativos ou apresentar um botão OAuth que não funciona.

Para uma integração direta da API do Claude, as alternativas documentadas incluem chave da Claude Console ou provedor de nuvem compatível, com uso separado da assinatura. Essa alternativa não é ativada automaticamente pelo Verifica.

- https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use
- https://platform.claude.com/docs/en/manage-claude/authentication


## Esforço de raciocínio

O painel e a extensão usam `selectedEffort`, com `default` representando a ausência de override. `lib/effort.mjs` centraliza opções e validação. Em ChatGPT, a preferência fica em `modelEfforts[model]` no registro criptografado da conexão. O catálogo pode restringir níveis por `supported_reasoning_efforts`; quando esse campo não é fornecido, usa-se a tabela explícita de modelos conhecidos. Modelos desconhecidos ficam no padrão. O teste de inferência registra modelo e effort, e a escolha da sessão é fixada ao iniciar.

Nas chamadas Responses de ChatGPT e Gateway, envia-se `reasoning: {effort}` apenas quando existe escolha explícita compatível. `none` é uma escolha explícita e não equivale a `default`. O fluxo de assinatura mantém `store:false`, `stream:true` e a lista anterior de campos permitidos. No Gateway, triagem e pesquisa têm preferências independentes mesmo se configuradas com o mesmo modelo; o limite de saída das chamadas com override sobe para pelo menos 16.384 tokens para acomodar raciocínio e JSON. A transcrição recebe apenas a credencial, sem reasoning.

No Gemini `generateContent`, modelos 3 ou posteriores cadastrados usam `generationConfig.thinkingConfig.thinkingLevel`. O Gemini 2.5 usa `thinkingBudget`: **low=1024**, **medium=4096**, **high=8192**. Estes três budgets são decisões do aplicativo, não equivalências oficiais de níveis entre provedores. Seu `maxOutputTokens` passa a 8192 + budget, reservando espaço para o texto final. Pesquisa e formatação usam a mesma escolha; respostas incompletas continuam rejeitadas. Não se envia `thinkingLevel` ao Gemini 2.5.

Chamadas com effort explícito têm timeout de 180 segundos; chamadas no padrão mantêm 45 segundos. Isso permite maior tempo de raciocínio sem remover o cancelamento da sessão. O limite não garante que qualquer chamada termine a tempo.

Referências oficiais verificadas em 23/10/2026:

- [OpenAI: reasoning.effort e diferenças por modelo](https://developers.openai.com/api/docs/guides/reasoning)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [Sign in with ChatGPT: catálogo e inferência](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Gemini: ThinkingConfig no contrato generateContent](https://ai.google.dev/api/generate-content#ThinkingConfig)
- [Gemini: níveis suportados por modelo](https://ai.google.dev/gemini-api/docs/thinking)

- [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)
