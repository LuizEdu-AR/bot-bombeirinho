# Bombeirinho | South State Fire Department (SSFD)

Bot de gerenciamento do **South State Fire Department (SSFD)** para servidores de roleplay no Discord, com integração ao **Firebase Cloud Firestore** e aos registros de serviço do **FiveM**.

O Bombeirinho reúne processos de cadastro, gestão de membros, controle de ponto, cursos, vistorias e registros administrativos em um único sistema.

> **Projeto desenvolvido para o ambiente do SSFD.** Os IDs de canais e cargos são específicos do servidor e devem ser revisados antes de reutilizar o código em outro Discord.

## Funcionalidades

| Módulo | Recursos |
| --- | --- |
| **Cadastro e setagem** | Painel de cadastro, aprovação/rejeição, atribuição de cargos e atualização de apelidos. |
| **Gestão de bombeiros** | Cadastro administrativo, gerenciamento de patentes e cargos, exoneração e restauração de cursos. |
| **Cursos** | Registro de certificações, sincronização dos cargos de cursos com o Firestore e recuperação dos cursos registrados. |
| **Controle de ponto** | Início, pausa, retomada e encerramento de ponto, além de acompanhamento administrativo. |
| **Integração FiveM** | Processamento de logs de entrada e saída de serviço para conciliação do ponto. |
| **Vistorias** | Cadastro e acompanhamento de estabelecimentos, agendamento, contato, conclusão e informes ao Jurídico. |
| **Hierarquia** | Exibição e atualização das informações de membros e patentes. |
| **Sugestões** | Recebimento e tratamento de sugestões pelo Discord. |
| **Auditoria** | Logs administrativos de ações relevantes, com histórico no Firestore. |

As funcionalidades são acionadas por **slash commands**, botões, menus e formulários nos canais configurados.

## Comandos disponíveis

| Comando | Finalidade |
| --- | --- |
| `/ping` | Verifica se o bot está online. |
| `/painel tipo:setagem` | Publica o painel de setagem no canal configurado. |
| `/ponto` | Inicia ou consulta o ponto de serviço. |
| `/cadastrar-bombeiro` | Cadastra manualmente um membro no Firestore. |
| `/sincronizar-cursos` | Registra no Firestore os cursos identificados nos cargos atuais dos membros. |
| `/sincronizar-ids` | Recupera IDs de RP ausentes a partir dos apelidos, com confirmação. |
| `/padronizar-nicks` | Apresenta prévia e confirmação da padronização de apelidos. |
| `/analisar-estabelecimentos` | Analisa registros históricos de estabelecimentos sem modificar o Firestore. |

**Permissões:** os comandos e as ações dos painéis possuem verificações específicas de acesso. Por exemplo, `/cadastrar-bombeiro` e `/sincronizar-cursos` são destinados aos cargos de **Manutenção, Chefe e Chefe Adjunto**. Outros comandos podem exigir a permissão `Gerenciar Servidor` ou cargos definidos no código.

## Tecnologias

- **Node.js 22+** (CommonJS)
- **discord.js 14**
- **Firebase Admin SDK / Cloud Firestore**
- **dotenv** para configuração por variáveis de ambiente
- Implantação opcional em **Linux/Ubuntu**, com execução contínua por `systemd`

## Estrutura do projeto

```text
.
├── src/
│   ├── commands/
│   │   └── definitions.js       # Definições dos slash commands
│   ├── config/
│   │   ├── ids.js               # IDs dos canais, cargos e cursos
│   │   └── registration.js      # Regras dos tipos de cadastro
│   ├── services/                # Regras de negócio e integrações
│   ├── utils/                   # Utilitários de permissões e patentes
│   ├── deploy-commands.js       # Registro dos comandos no Discord
│   └── index.js                 # Inicialização e eventos do bot
├── scripts/                     # Ferramentas administrativas pontuais
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Instalação local

### 1. Pré-requisitos

- Node.js 22 ou superior e npm;
- Aplicação/bot criado no [Discord Developer Portal](https://discord.com/developers/applications);
- Projeto Firebase com **Cloud Firestore** e credenciais do **Firebase Admin SDK**;
- Permissões do bot para visualizar canais, enviar mensagens, usar comandos, gerenciar cargos e apelidos, conforme os módulos utilizados.

No Discord Developer Portal, habilite os *Privileged Gateway Intents* **Server Members Intent** e **Message Content Intent**. O cargo do bot deve estar acima dos cargos que ele precisa gerenciar.

### 2. Instalar dependências

```bash
npm ci
```

### 3. Configurar o ambiente

Crie um arquivo `.env` a partir de `.env.example`:

```env
DISCORD_TOKEN=seu_token_do_bot
DISCORD_CLIENT_ID=id_da_aplicacao
DISCORD_GUILD_ID=id_do_servidor
FIREBASE_SERVICE_ACCOUNT_PATH=./firebase-service-account.json
# Opcional: deslocamento dos horários dos logs FiveM em minutos
FIVEM_LOG_UTC_OFFSET_MINUTES=-180
```

Baixe a chave JSON da conta de serviço no **Firebase Console > Configurações do projeto > Contas de serviço** e salve-a em um local seguro. O caminho configurado em `FIREBASE_SERVICE_ACCOUNT_PATH` é resolvido a partir da pasta em que o processo é iniciado.

Alternativamente, sem `FIREBASE_SERVICE_ACCOUNT_PATH`, o SDK tenta usar as **Application Default Credentials** do ambiente.

**Nunca publique o token, o `.env`, a chave JSON do Firebase ou outras credenciais no GitHub.**

### 4. Revisar IDs do servidor

Edite `src/config/ids.js` e confira os IDs dos canais, cargos, cursos e integração de logs. Esses valores são específicos do Discord do SSFD.

### 5. Registrar comandos e iniciar

```bash
npm run deploy:commands
npm start
```

Para desenvolvimento com reinicialização automática:

```bash
npm run dev
```

O registro dos comandos utiliza a API de comandos **do servidor** configurado em `DISCORD_GUILD_ID`.

## Execução em servidor Linux

Após instalar o Node.js e transferir o projeto para o servidor:

```bash
cd /caminho/do/projeto
npm ci
npm run deploy:commands
npm start
```

Para manter o bot ativo após desconectar do SSH, configure um serviço `systemd` apontando para `src/index.js` ou `npm start`, com o diretório de trabalho correto e acesso seguro às credenciais. Reinicie o serviço após publicar alterações. **Não inclua segredos em arquivos versionados.**

## Persistência e integração

- O **Cloud Firestore** armazena os registros utilizados pelos módulos do bot.
- A sincronização de cursos acrescenta certificações identificadas nos cargos do Discord aos registros do Firestore, sem remover cursos já armazenados.
- A restauração de cursos depende de registros existentes: cursos removidos antes de qualquer registro persistente não podem ser recuperados automaticamente.
- A integração de ponto com o FiveM lê mensagens do canal de logs configurado; seu funcionamento depende do formato dessas mensagens.
- A exoneração deve preservar o histórico de certificações, mesmo quando os cargos organizacionais são removidos.

## Segurança e publicação no GitHub

Antes do primeiro `git push`, confira:

- [ ] `.env` e chaves privadas não estão no repositório nem no histórico de commits.
- [ ] `firebase-service-account.json` não foi incluído.
- [ ] `node_modules/` e arquivos de log não foram adicionados.
- [ ] Os IDs e canais em `src/config/ids.js` correspondem ao ambiente desejado.
- [ ] As permissões dos comandos administrativos foram revisadas.
- [ ] O bot foi testado em um ambiente de desenvolvimento antes de usar dados de produção.

> **Atenção:** o `.gitignore` protege apenas arquivos que ainda não estão sendo rastreados pelo Git. Se alguma credencial já foi publicada, remova-a do histórico e **revogue/rotacione** o segredo comprometido.

## Scripts npm

```bash
npm start                # Inicia o bot
npm run dev              # Executa com --watch
npm run deploy:commands  # Registra os slash commands
```

## Observações

Este repositório contém a implementação do bot para o servidor SSFD. A instalação em outros servidores exige ajustar canais, cargos, permissões e, quando necessário, os formatos dos logs de integração.

---

**Bombeirinho** — Sistema de apoio à gestão do South State Fire Department.
