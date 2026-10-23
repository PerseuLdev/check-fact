# Verifica para Chrome

Extensão Manifest V3 com painel lateral, leitura do vídeo atual do YouTube e cartões sobre o player. Requer Chrome 116+ e o servidor local deste projeto. Esta pasta é carregável diretamente, sem build nem dependências de npm.

## Instalar

1. Na raiz do projeto, execute `npm.cmd run dev` (veja no README principal os requisitos de Python, FFmpeg e transcrição).
2. No Chrome, abra `chrome://extensions`, ative **Modo do desenvolvedor** e selecione **Carregar sem compactação**.
3. Selecione a pasta `C:\vs_code\check-fact\extension`.
4. Fixe **Verifica** na barra e clique no ícone para abrir o painel lateral.
5. Em **Conectar motor local**, abra o link do código, copie-o e cole no painel. O código muda ao reiniciar o servidor.
6. Abra **Configurar IA e transcrição** para configurar a conta/modelo pelo painel local existente.
7. Abra um vídeo no YouTube. Recarregue abas que já estavam abertas quando a extensão foi instalada. Use **Atualizar** se necessário.
8. Posicione o vídeo, informe a data da fala se conhecida e clique em **Iniciar checagem**. **Testar áudio** não chama IA.

## Comportamento e limites

- O motor lê o áudio pela URL. Não captura o áudio da aba. Pausar, avançar, alterar a velocidade ou trocar o vídeo não sincroniza nem encerra o motor. Encerre e reinicie para mudar de trecho. Lives seguem o ponto entregue pela plataforma.
- A transcrição local agora usa janelas de 12 segundos com quatro segundos de sobreposição, busca com feixe 5 e tentativas alternativas para trechos de baixa pontuação. A triagem usa 90 segundos recentes e pode recuperar até 3 minutos. Janelas maiores podem elevar a latência e não eliminam erros de reconhecimento.
- Em vídeos gravados, ao começar no meio do vídeo, o motor transcreve localmente até 90 segundos anteriores ao ponto escolhido antes de iniciar a checagem. Isso pode levar alguns segundos e prepara contexto sem publicar checagens antigas. Lives começam no ponto de áudio que a plataforma entregar.
- Uma única sessão é compartilhada pelo painel web e pela extensão. **Encerrar** encerra essa sessão, mesmo se iniciada pelo painel web.
- Fechar o painel lateral mantém o motor funcionando. Os cartões sobre o player deixam de atualizar e desaparecem em até seis segundos. Reabrir retoma a consulta do estado.
- O overlay aparece no player padrão `#movie_player`, inclusive em tela cheia quando o YouTube mantém esse elemento. Outros players/layouts podem não exibi-lo; os resultados continuam no painel lateral.
- Só cartões do vídeo correspondente, publicados nos últimos 30 segundos, aparecem no overlay. Resultados em reavaliação são ocultados. O botão × dispensa aquela revisão do cartão.
- As fontes são links; a extensão não trata texto de IA como HTML nem permite URLs `javascript:`.
- Login e credenciais de IA permanecem no servidor. A extensão guarda somente o código local de pareamento em `chrome.storage.local`, restrito aos contextos da extensão, sem sincronização com a conta Chrome. As rotas de login existentes não foram abertas para acesso entre origens.
- O acesso de rede é restrito ao servidor local. O script de conteúdo roda apenas em `www.youtube.com` e `m.youtube.com`, sem acesso geral a todos os sites. `activeTab` permite consultar a aba selecionada quando o usuário aciona a extensão.
- A distribuição é local. O ZIP precisa ser extraído antes de **Carregar sem compactação**. Não houve publicação na Chrome Web Store.

## Validação

`npm.cmd test` cobre o pareamento, rejeição de origens/chaves inválidas, comandos permitidos e seleção de cartões por vídeo, prazo e estado. O build valida a integração das rotas com o servidor. A instalação no Chrome, abertura do painel, leitura do player e tela cheia precisam de validação manual na instalação de destino; testes automatizados não comprovam esses fluxos reais nem a correção factual da IA.
