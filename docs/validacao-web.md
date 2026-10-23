# Verificação da versão web — 23/10/2026

## Fluxo verificado

Página no navegador → seleção de arquivo WAV sintético → AudioWorklet → reamostragem PCM mono 16 kHz → envio ordenado à sessão HTTP → motor → faster-whisper real → SSE → transcrição na página → download TXT.

O arquivo de teste foi gerado localmente com a voz Windows Microsoft Maria Desktop, em português, contendo aproximadamente 16,8 segundos de fala. Não foi utilizado áudio de terceiros nem feita uma chamada de IA de checagem nesse teste.

Resultado observado no navegador: 16 segundos contabilizados, dois segmentos transcritos e estado concluído. A captura terminou automaticamente ao fim do arquivo. O TXT baixado conservou os dois trechos e seus intervalos. Houve imperfeições de ASR na fronteira dos blocos; a validação comprova execução do fluxo, não acurácia da transcrição ou precisão factual.

## Verificações automatizadas

Os testes web cobrem isolamento entre navegadores, cookie seguro e host-bound em HTTPS, CSRF e origem, sessão inválida, código opcional de acesso, limites de corpo e fila, propriedade e ordem dos blocos, cancelamento de início pendente, concorrência, expiração, remoção de sessão, cancelamento de SSE, duração da reamostragem e transferência de ArrayBuffer sem perda dos blocos posteriores.

O teste de transferência detecta uma diferença importante do AudioWorklet: enviar um buffer por transferência o desanexa do remetente. A implementação aloca o próximo buffer antes de transferir o anterior.

O build do painel eve anterior concluiu após manter o novo serviço em uma entrada separada (`web-server.mjs`). A extensão não foi migrada para o serviço web e mantém seu endereço e pareamento locais.

## Inspeção visual

O navegador carregou a nova página, o diálogo de IA e a demonstração de cartão. Na largura emulada de 390 px não foi detectado overflow horizontal. O cartão foi exibido sobre o player, com indicação de demonstração sem avaliação factual. Isso não substitui teste em iPhone/Android físicos.

Captura, áudio sintético e TXT utilizados na verificação estão em `outputs/`, ignorada pelo Git. Nenhuma credencial real foi adicionada aos testes.

## Limites desta execução

- Não houve contratação de domínio, hospedagem ou publicação externa.
- A configuração Docker Compose foi validada. O Docker Engine local estava indisponível, então a imagem não foi construída nem executada nesta máquina.
- Microfone e compartilhamento de aba/sistema exigem autorização e teste real no dispositivo/navegador. Não foi capturado o microfone do usuário nem uma aba privada para esta validação.
- Não foi executado novo login real ChatGPT ou inferência paga nesta versão. O contrato de autorização e isolamento foi testado com respostas simuladas. O uso hospedado de API precisa de uma chave explicitamente configurada pelo visitante.
- Não há confirmação de captura do Globoplay, de compatibilidade com conteúdo protegido ou de funcionamento sobre outros apps. Não foi implementado aplicativo nativo Android/iOS nem reconhecedor nativo Apple/Microsoft.
