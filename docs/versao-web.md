# Verifica web: celular, áudio e domínio

Esta versão é executada com `npm.cmd run web`. É independente do painel eve da extensão (`npm.cmd run dev`) e reutiliza seu motor de checagem. Não é necessário instalar extensão no dispositivo visitante.

## Executar no computador

Na raiz, instale as dependências conforme o README principal (npm, ambiente Python, requirements e FFmpeg) e execute:

```powershell
npm.cmd run web
```

Abra <http://127.0.0.1:4311>. O serviço vincula-se a loopback por padrão. Não copie credenciais de outros aplicativos ou da instalação desktop. A conexão de IA desta versão é separada e temporária.

## Como usar

1. Escolha YouTube, Arquivo, Áudio de uma aba (quando suportado) ou Microfone.
2. Para YouTube, cole um link e selecione **Abrir vídeo**. Para arquivo, escolha um áudio ou vídeo local. Na captura, a seleção e a autorização acontecem ao começar.
3. Use **Só transcrever** para testar sem login e sem chamadas de IA de análise. O primeiro uso carrega o modelo Whisper no servidor e pode baixar seus arquivos.
4. Para checar, abra **Configurar IA** e conecte explicitamente um provedor. O modo local em `http://127.0.0.1` oferece o login de plano ChatGPT; a versão HTTPS oferece uma chave do Vercel AI Gateway, com créditos e cobrança próprios. A chave não é compartilhada entre visitantes.
5. Escolha **Transcrever e checar afirmações** e comece. Informe a data original da fala nas opções avançadas quando conhecida; não substitua pela data de upload.
6. Acompanhe a transcrição, os cartões e os links das fontes. **Baixar .txt** exporta os trechos recebidos enquanto esta página esteve aberta.
7. Use **Encerrar** para parar a captura; o restante do áudio já recebido é processado antes de concluir. **Apagar esta sessão** remove dados e credenciais da memória desta sessão.

O navegador precisa permanecer aberto e ativo durante a captura. O serviço pode parar uma captura que deixa de enviar áudio por 45 segundos; bloqueio de tela e suspensão em segundo plano variam por dispositivo.

## Celular

- YouTube incorporado e arquivo local têm player e cartões dentro da mesma página. Incorporação e formatos dependem do vídeo, serviço e navegador.
- Microfone depende da autorização e de HTTPS. Áudio de aba só aparece se o navegador oferecer a API; não é prometido no Android ou iPhone.
- O áudio capturado é enviado ao servidor que hospeda o Verifica. Não é reconhecimento nativo da Apple/Microsoft nem processamento no celular.
- **Ampliar vídeo e cartões** tenta ampliar o conjunto; quando a API de tela cheia não existe, usa a área visível da própria página. Toque duas vezes fora do cartão para voltar. A tela cheia nativa do player pode ocultar elementos da página.
- Um site/PWA não coloca cartões sobre outros apps. Captura e janela sobre o Globoplay no Android exigem um app nativo, com permissões e validação; não fazem parte desta versão.
- Globoplay não foi incorporado nem apresentado como uma integração validada. No computador, é possível tentar compartilhar uma aba com áudio, mas conteúdo protegido pode bloquear áudio ou imagem.
- A captura de arquivo/microfone/aba acompanha o som realmente recebido. Na entrada por URL YouTube, o servidor lê uma conexão própria: ao pausar, avançar ou mudar de trecho, encerre e reinicie no ponto desejado. Lives começam no ponto entregue pela plataforma.

## Sessões e limites

O novo servidor não expõe as rotas administrativas do framework eve nem o pareamento local da extensão. Usa cookie aleatório HttpOnly, SameSite=Lax, Secure em HTTPS; valida origem e token CSRF nas mutações; protege a ordem dos blocos e limita tamanho, frequência e velocidade de áudio. Não aceita URL arbitrária de mídia.

Há uma execução e uma conexão por sessão do navegador. Abas do mesmo navegador compartilham essa sessão; navegadores distintos são isolados. Sessões expiram após 30 minutos sem solicitações. A página aberta consulta o estado periodicamente. Máximo padrão: 80 sessões, 12 por endereço de conexão e duas execuções simultâneas. Uma execução dura até duas horas. No proxy do compose, os visitantes compartilham o endereço do proxy, logo o limite de 12 é também o limite prático de sessões simultâneas desse teste. Ampliar público requer revisar capacidade e rate limit no proxy, não confiar em IP encaminhado arbitrariamente.

Um modelo ASR é compartilhado em RAM e os trabalhos são serializados com fila limitada; dados, contexto e saídas são separados. Não há gravação de áudio, transcrições, cartões ou chaves em arquivo na versão web. O modo eve anterior mantém seus próprios registros e comportamento.

O estado é temporário: reiniciar o serviço perde as sessões e conexões. Esta entrega suporta uma única instância. Não use múltiplas réplicas sem mover sessões, autorização e filas para um armazenamento coordenado. Não utiliza uma chave global do operador para cobrar visitantes automaticamente.

## Publicar quando houver domínio e servidor

O runtime precisa de Node 24, Python, FFmpeg e memória/CPU para ASR contínuo. Hospedagem estática ou um Worker sem processos Python não executa este motor. A configuração entregue usa Docker com proxy HTTPS Caddy.

1. Providencie um servidor Linux com Docker e Compose. Dimensione a máquina com um teste do modelo e da simultaneidade desejada; não há benchmark de capacidade da hospedagem nesta entrega.
2. Aponte um subdomínio para o IP do servidor. Libere portas 80 e 443 para o Caddy emitir o certificado. Não exponha a porta interna 4311.
3. Copie o projeto sanitizado para o servidor. Não envie `node_modules`, `.venv`, `.eve`, `.output`, `.env`, `data`, `media`, `outputs` ou credenciais locais. O Dockerfile copia apenas o runtime necessário.
4. Na pasta `deploy`, copie `.env.example` para `.env`. Preencha o domínio real e um código de acesso privado para o teste. Mantenha esse arquivo fora do Git.
5. Na pasta `deploy`, execute:

```sh
docker compose --env-file .env up -d --build
```

6. Abra o domínio HTTPS. Informe o código de acesso, teste uma transcrição conhecida e uma checagem com uma conexão de API autorizada. Confira que outro navegador não vê a conexão nem os resultados do primeiro.
7. Antes da divulgação pública, teste em Android/iPhone reais, faça a revisão de dados/contato na página de privacidade e confirme latência/capacidade no servidor. O código de acesso mantém a primeira instalação como teste controlado.

O cache de modelos é persistido em volume; dados de usuários não. Nenhum domínio foi registrado e nenhum serviço foi contratado ou publicado por esta implementação.

## Limite do login ChatGPT

A documentação oficial do fluxo OSS exige callback HTTP em `127.0.0.1`; não foi substituído por um retorno HTTPS inventado. O login de identidade de um site também não deve ser confundido com autorização para usar o plano. A instalação hospedada usa a API explicitamente selecionada pelo visitante.

Fonte: [OpenAI — registro e login](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).
