# Verifica — checagem incremental por URL

## Extensão do Chrome

A versão de extensão fica em [`extension/`](extension/README.md). Execute o servidor local e carregue essa pasta em `chrome://extensions` → **Modo do desenvolvedor** → **Carregar sem compactação**. O painel lateral identifica o vídeo do YouTube aberto, inicia a checagem no ponto selecionado e mostra fontes e cartões sobre o player. O pareamento é feito em http://127.0.0.1:4310/extension.

Essa versão reutiliza o motor local: Python, FFmpeg, transcrição e login continuam no computador. O áudio é lido pela URL; pausas e avanços do player não sincronizam o motor. Veja as instruções completas e os limites no README da extensão.

Protótipo local de acompanhamento de vídeos e lives do YouTube. A entrada principal é uma URL. O usuário não precisa baixar o vídeo, enviar arquivo ou esperar a transcrição completa.

## Abrir

Em PowerShell, na pasta do projeto:

```powershell
npm.cmd install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
npm.cmd run dev
```

Pré-requisitos: Python 3.12+, FFmpeg no PATH, npm e conexão com a internet. O comando de desenvolvimento usa Node 24 através de `npx`, sem substituir o Node global. As dependências já foram instaladas nesta máquina.

- Painel: http://127.0.0.1:4310/
- Overlay transparente: http://127.0.0.1:4310/overlay
- No OBS: Fonte de navegador, URL do overlay, 1920 × 1080.

O servidor só escuta a interface local. Não é uma publicação na internet.

## Usar

1. Cole o link e selecione **Conectar URL**.
2. Opcionalmente, selecione **Testar áudio · 8 s**. Esse teste não usa IA nem emite vereditos.
3. Se a data da fala for conhecida, informe-a. A data de upload não é tratada como data confirmada do debate.
4. Abra **Configurar IA → Continuar com ChatGPT**. Entre e autorize o uso do plano na janela da OpenAI. O fluxo usa o registro dinâmico oficial, callback em `http://127.0.0.1:4310/auth/callback`, PKCE, state e validação criptográfica do ID token. Não é preciso fornecer uma chave de API para esse modo.
5. Escolha um modelo no catálogo retornado para a conta. `gpt-6-luna` é pré-selecionado somente se esse identificador aparecer no catálogo; outro modelo exige seleção. Use **Testar modelo** para confirmar uma chamada concluída. Aparecer no catálogo não garante acesso à inferência ou à pesquisa web. As chamadas consomem os limites existentes do plano, conforme as permissões da conta.
6. A transcrição local é preparada antes de abrir o áudio. Você também pode usar **Preparar transcrição** e **Testar 12 s do vídeo**, sem login. O teste curto só transcreve e não publica vereditos.
7. Para uma execução curta, use **Testar checagem · 30 s** nas configurações. Esse teste usa a URL e o ponto inicial do painel, transcreve, analisa e pesquisa, consumindo uso do plano. Para acompanhar continuamente, selecione **Iniciar checagem**. No modo ChatGPT, os blocos de áudio são processados localmente por faster-whisper; apenas texto e contexto são enviados para análise. A pesquisa web depende da disponibilidade e da política da conta.
8. Os cartões são publicados automaticamente no painel e no overlay. O overlay mostra o último resultado por 30 segundos e oculta resultados em reavaliação.
9. Para mudar o ponto de reprodução, encerre e inicie no número de segundos desejado. Em uma live, o início é o ponto entregue pela plataforma.

### Contas e autorização

O aplicativo mantém registros separados para conexões e workspaces, mesmo que o email coincida. O usuário pode selecionar uma conexão salva, adicionar outra e desconectar. Reconectar reutiliza o client ID emitido; reiniciar não cria outro host ID. No Windows, os registros são criptografados com DPAPI para o usuário atual e armazenados fora do projeto, em `%LOCALAPPDATA%\Verifica\ChatGPT\connections.dat`. Tokens não são enviados ao frontend, overlay ou registros de checagem. Uma autorização que concede apenas identidade não habilita inferência.

Tokens são renovados perto da expiração, com uma renovação por vez no processo. Esta aplicação local usa uma única instância do servidor; não compartilhe o arquivo de conexões com outro processo. Falhas temporárias preservam a conexão; erros definitivos pedem novo login. Desconectar tenta revogar a sessão renovável e sempre limpa os tokens locais, informando quando a revogação remota não foi confirmada. Gerencie permissões e limites também em [ChatGPT → Uso](https://chatgpt.com/settings/usage).

A alternativa por Gateway fica em uma seção separada e só é utilizada quando selecionada explicitamente. Não há troca automática de cobrança quando o plano do ChatGPT falha. Uma chave do Gateway permanece apenas na memória do servidor.

O player incorporado é uma referência opcional. A leitura do áudio usa uma conexão própria, e pode haver diferença de sincronização. Os controles do player não controlam o motor. O YouTube pode impedir a incorporação mesmo quando a leitura do áudio funciona; nesse caso, abra o original separadamente.

## Processamento

```text
URL → resolver áudio → FFmpeg no ritmo de reprodução
    → blocos de 12 s + 4 s de sobreposição para transcrição local
    → triagem de afirmações com 90 s de contexto recente
    → recuperar até 180 s anteriores quando solicitado
    → reter trechos curtos e aguardar um bloco posterior à fala selecionada
    → pesquisa web de evidências → validação da origem das fontes
    → publicação automática no painel + overlay
```

O motor começa no ponto atual do player e, em vídeos gravados, prepara localmente até 90 segundos anteriores antes da checagem para dar contexto à primeira fala. Não transcreve o vídeo inteiro antecipadamente nem envia o áudio à IA. Depois, só libera trechos conforme o tempo da reprodução simulada; os últimos 180 segundos de texto ficam disponíveis para recuperar contexto, e os cartões conservam os trechos utilizados.

A janela de transcrição foi ampliada de 8 para 12 segundos, com quatro segundos de sobreposição. O modelo local usa busca com feixe 5 e tenta decodificações alternativas quando a primeira tem baixa pontuação. A triagem considera 90 segundos recentes e pode recuperar até três minutos quando precisa de contexto anterior. Isso melhora continuidade e contexto, mas pode aumentar a latência e ainda não garante acurácia; erros de ASR precisam continuar visíveis e podem exigir revisão.

O motor exige que a citação selecionada tenha pelo menos 12 palavras e 60 caracteres normalizados. Frases curtas, inclusive perguntas, ficam retidas para nova triagem com a continuação; uma paráfrase longa ou o texto ao redor não substitui esse mínimo na citação literal. A IA deve selecionar uma passagem maior relacionada ao mesmo assunto, sem preencher o mínimo com frases alheias. Mesmo com esse tamanho, é necessário receber um bloco transcrito posterior ao fim da citação para considerar ressalvas e autocorreções. A verificação de tamanho e continuação é aplicada pelo motor, independentemente da decisão da IA. Esses critérios são conservadores: podem deixar falas curtas completas sem checagem e acrescentam a espera por pelo menos mais um bloco, normalmente de 12 segundos, além do processamento. Não garantem compreensão semântica. Ao encerrar o áudio, os fragmentos ainda pendentes permanecem sem checagem.

Com ChatGPT, as chamadas de inferência usam apenas `https://api.openai.com/v1/responses`, `store:false`, `stream:true` e contexto explícito. Campos não suportados pelo fluxo são removidos; uma resposta só é aceita após `response.completed`. O leitor conserva os itens concluídos dos eventos anteriores quando o evento terminal traz `output:[]`, inclusive mensagens e proveniência da pesquisa. Respostas interrompidas ou limite do plano não são transformados em veredito nem desviados para outra forma de cobrança. No modo alternativo por Gateway, permanece a transcrição em nuvem e o contrato anterior.

A transcrição, a triagem e a pesquisa trabalham em filas independentes. Há até duas pesquisas simultâneas, no máximo oito esperando. Quando a fila de pesquisa chega ao limite, a nova afirmação é marcada como não checada, visível no painel, sem inventar um veredito. Uma fila de transcrição superior a 48 segundos encerra a sessão com aviso.

Uma URL escrita pelo modelo não basta para publicar um resultado factual: ela precisa constar nas fontes retornadas pela ferramenta de pesquisa. Essa validação comprova a origem registrada, mas não garante que a interpretação semântica esteja correta. A adequação das evidências e a precisão factual ainda precisam ser avaliadas em testes reais.

O detector pode sinalizar que uma fala nova corrige uma afirmação anterior. Isso invalida uma pesquisa anterior em andamento e atualiza o mesmo cartão. O reconhecimento de correções é feito por IA e pode falhar.

Há uma trava independente do modelo para referências temporais relativas reconhecidas no texto, como “nos últimos anos”, “há 20 anos”, “hoje” e “atual governo”. Sem a data confirmada da fala, essas afirmações recebem **evidências insuficientes**, antes da pesquisa, com a indicação de informar a data e repetir o trecho. Essa trava é conservadora e baseada em padrões de texto, não cobre todas as formas possíveis de referência temporal. Não usa o upload ou o relógio atual como substituto.

## Resultado e taxonomia

Resultados principais: correta, correta com ressalvas, parcialmente correta, falsa, evidências insuficientes e inconclusiva. Tags incluem exagero, subestimação, contexto ausente, fora de contexto, dado desatualizado, recorte seletivo, erro numérico, comparação inadequada e causalidade não demonstrada.

O sistema avalia afirmações. Não infere intenção de mentir, identidade de voz, personalidade ou culpa. Vozes não são identificadas neste protótipo. Perguntas factuais podem receber uma resposta contextual com fontes; perguntas com uma premissa verificável têm a premissa checada. Opiniões puras e previsões futuras não recebem veredito factual.

## Registros e medição

Os cartões publicados, fontes e contexto usado são registrados em `data/<sessao>.jsonl`, ignorada pelo Git. Não há credenciais nem mídia nesses registros. O vídeo não é redistribuído pelo overlay.

A latência exibida vai do fim do bloco de áudio que contém a afirmação até a publicação. A granularidade é de bloco; não há timestamps de palavras nem uma medição exata do fim da frase. Recuperação de contexto, transcrição, rede e pesquisa compõem essa demora. Não existe promessa de 10–30 segundos sem medir o fluxo real.

## Validação em 19/10/2026

- `npm.cmd test`: 22 testes passaram, cobrindo contexto, proveniência de fontes, URL, cancelamento, ritmo de reprodução, OAuth, leitura dos eventos de streaming e abstenção obrigatória sem a data de uma afirmação temporal relativa. Respostas de IA nesses testes são simuladas e não medem qualidade factual.
- `npm.cmd run build`: build do servidor e dos canais concluído.
- Teste real pelo navegador: URL `https://www.youtube.com/watch?v=BgjpOorIXoI`, conexão de metadados e captura de oito segundos de áudio concluída, sem IA e sem vereditos.
- Overlay servido com fundo transparente; sem cartões publicados recentes, permanece vazio.
- Transcrição local real: `small`, CPU/int8, um trecho de 4 segundos processado em aproximadamente 1,7 segundo. A transcrição produzida não foi revisada contra o áudio; esse teste mede execução e tempo, não acurácia.
- Teste real pelo painel: 12 segundos de áudio da URL, a partir de 03:00, geraram três trechos locais, sem chamadas de inferência e sem checagens publicadas.
- Testes de OAuth: PKCE, host persistente, state/replay, assinatura e nonce de ID token, consentimento só de identidade, renovação serializada, escopos reduzidos, cancelamento durante troca de código, armazenamento criptografado e streaming com falhas/fragmentação. Tokens e respostas externos usados nesses testes são simulados.
- Login real com ChatGPT concluído. `gpt-6-luna` retornado no catálogo da conta, selecionado e confirmado por uma resposta real concluída. O teste do vídeo também conseguiu realizar pesquisa web com essa conexão, sem chave do Gateway.
- Uma execução real de 30 segundos, iniciada em 10:00, gerou uma pesquisa com duas fontes registradas e publicação em 22,3 segundos após o fim do bloco. **Esse resultado não valida a correção factual**: a IA apresentou uma conclusão apesar da data não confirmada e um cálculo inconsistente. Isso motivou a trava temporal descrita acima. Tempos de testes de abstenção, sem pesquisa, não devem ser comparados como se fossem latência de checagem factual.
- Repetição final após as correções: 30 segundos de áudio, quatro segmentos, uma afirmação e uma publicação automática de **evidências insuficientes**, pois a data da fala não foi confirmada. A publicação foi observada no painel e no overlay. A abstenção ocorreu em 6,3 segundos após o bloco; não houve pesquisa nesse cartão. O fragmento final incompleto ficou aguardando continuação. Registro técnico em `outputs/teste-chatgpt-real.json` e capturas em `outputs/painel-chatgpt-real.png` e `outputs/overlay-chatgpt-real.png`.
- Reprodução incorporada deste vídeo: o player informou indisponibilidade no navegador de teste; isso não impediu a captura de áudio do backend.

## Limites atuais

Entrada por YouTube; outras plataformas ainda não são suportadas. Bloqueios de plataforma e URLs assinadas expiradas podem interromper a captura. Se a leitura falhar antes do primeiro bloco, há uma tentativa automática de renovar a conexão. Acesso intermitente foi observado no teste real. Retomada automática depois de uma captura já iniciada e medição/compensação da diferença entre o player e o motor ainda não foram implementadas.

O protótipo analisa a fala. Não faz OCR de gráficos, autenticação de vídeos, identificação de deepfake nem análise visual. A transcrição usa blocos curtos em um processo local persistente, não uma sessão de ASR por WebSocket. Não há revisão humana integrada nem postagem em redes sociais. O login com ChatGPT não dá acesso à API de áudio; por isso a transcrição local é parte necessária desse modo.

Dependências do framework incluem uma cadeia com `sprintf-js` sem correção disponível no registro consultado; a auditoria aponta risco de negação de serviço. O painel não oferece entrada para formatos dessa biblioteca, e usa apenas escuta local, mas o aviso permanece na árvore de dependências. A dependência transitiva `undici` de `guarded-fetch` foi atualizada para 7.30.1 por override compatível de mesma versão principal. Não usar `npm audit fix --force`, que propôs downgrade incompatível do framework.

Referências técnicas: [Vercel — busca web](https://vercel.com/docs/ai-gateway/models-and-providers/web-search), [Vercel — transcrição](https://vercel.com/docs/ai-gateway/modalities/speech-to-text), [OpenAI — pesquisa e fontes](https://developers.openai.com/api/docs/guides/tools-web-search).

Referências do OAuth: [Registro e login](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [Contas e renovação](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [Modelos e inferência](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [Limitações do fluxo](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).


## Ampliação de contexto, perguntas e teste visual

A triagem usa 90 segundos recentes e pode recuperar até 180 segundos. Segmentos que aguardam continuação são retidos para a próxima rodada, mesmo que uma afirmação tenha começado no bloco anterior. A análise pode extrair até seis itens por rodada, preservando ids de trechos incompletos. O painel mostra decisões recentes de triagem. O limite de fila de transcrição de 48 segundos é medido em duração real dos blocos.

O título/canal e o campo opcional de contexto ajudam a identificar o tema; não comprovam fatos ou palavras. Hipóteses como NSS/INSS mantêm a citação original e são identificadas separadamente. Uma interpretação de sigla incerta bloqueia o veredito factual até confirmação.

Em `/assistir`, o vídeo e o overlay formam uma composição única com botão de tela cheia, teste visual local e prévia da última checagem. O teste de demonstração não usa IA nem é publicado no OBS. O overlay independente em `/overlay` continua mostrando cartões por 30 segundos. A prévia conserva o último para facilitar o ajuste.

O vídeo indicado retornou erro 150 no player incorporado. Foi testado o cartão sobre o player e o modo de tela cheia, incluindo uma resposta real. A captura opcional de aba em “Usar aba do YouTube” depende da seleção explícita do usuário no navegador; essa seleção e reprodução ainda precisam de validação manual. O compartilhamento exibe a imagem localmente, não grava nem envia a tela ao servidor; o som continua na aba original.

Validação desta ampliação: 25 testes automatizados passaram e o build foi concluído. Um teste real de 30 segundos a partir de 10:00 identificou cinco itens (uma afirmação e quatro perguntas), publicou quatro abstenções e uma resposta contextual, e encerrou sem falhas de pesquisa. Isso não constitui medida de cobertura ou acurácia. Registro: `outputs/teste-perguntas-contexto.json`. Captura da composição real: `outputs/overlay-pergunta-real-tela-cheia.png`.

## Conexão do Gemini e UX

A seleção de arquivo saiu do fluxo principal e ficou restrita à opção recolhida **Configuração avançada · API do Google Cloud**. O painel informa que o login simplificado está indisponível; não pede arquivos para resolver essa limitação e não marca a conexão como pronta.

Em 19/10/2026, o teste real do Gemini CLI 0.55.1 anunciou `oauth-personal`, mas rejeitou a autenticação porque o cliente não é mais suportado para contas pessoais. O [comunicado oficial do Google](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) confirma o encerramento em 18/06/2026. A implementação ACP permanece experimental e está bloqueada na fachada usada pelo servidor.

O Antigravity CLI instalado retornou modelos, mas uma inferência mínima terminou com `timeout waiting for response`; catálogo não comprova inferência ou login utilizável. Não foi integrado ao motor nem foram extraídos tokens. O modo API avançado permanece separado, sem fallback automático. A conexão ChatGPT existente continua disponível.

Validação: testes automatizados e build; login simplificado Gemini indisponível.

## Configuração avançada da Gemini API e disponibilidade do Claude

Abra **Configurar IA → Gemini → Configuração avançada · API do Google Cloud**. A integração usa a Gemini API do seu próprio projeto Google Cloud, com cotas e eventual cobrança separadas da assinatura do aplicativo Gemini. O programa não ativa faturamento nem faz fallback de provedor.

1. Habilite a Generative Language API no projeto Google Cloud.
2. Configure Google Auth platform e, em modo de teste, adicione a própria conta como usuário de teste.
3. Em Clients, crie um cliente do tipo **Desktop app** e baixe o JSON.
4. Na interface local, selecione esse arquivo e use **Importar cliente Google**. Não envie o JSON pelo chat.
5. Use **Continuar com Google**, autorize na página oficial, selecione um modelo retornado pelo catálogo e use **Testar modelo Gemini**. O teste de inferência utiliza a API.
6. Selecione **Usar Gemini na checagem**. Quando o login concluir e o catálogo trouxer o modelo padrão, o fluxo também pode retornar ao painel com Gemini selecionado. Nenhuma checagem é iniciada automaticamente.

Configuração e tokens Google são armazenados separadamente do ChatGPT em `%LOCALAPPDATA%\Verifica\Gemini\connections.dat`, criptografados com DPAPI no Windows. Há PKCE, state, renovação serializada e tentativa de revogação ao desconectar. Senha Google, tokens e client secret não aparecem no painel, SSE, overlay ou registros de checagem. O arquivo original não é copiado para o repositório; somente os campos necessários são salvos no armazenamento protegido. O servidor deve continuar sendo executado em uma única instância.

O Gemini participa da mesma triagem, pesquisa e publicação. O áudio continua local. A pesquisa usa Google Search e conserva somente as fontes registradas no grounding. A formatação estruturada acontece em uma segunda chamada, sem misturar ferramentas e JSON em modelos sem esse suporte. Uma URL inventada pelo texto do modelo não passa pela validação de proveniência. Algumas fontes do Google podem ser URLs de redirecionamento de grounding.

O login Claude.ai em aplicativos de terceiros não é oferecido pela integração oficial consultada. A interface documenta essa limitação. A alternativa por Claude API/provedor de nuvem não foi ativada, e nenhum token de Claude Code é importado.

**Validação:** 40 testes automatizados passaram e o build foi concluído, incluindo testes de contrato e segurança Google com respostas simuladas. A conta ChatGPT existente permanece disponível. O OAuth e a inferência Gemini com conta real ainda dependem do JSON do cliente e do consentimento do usuário; não foram apresentados como verificados ao vivo. Detalhes e fontes oficiais: [docs/provedores.md](docs/provedores.md).
