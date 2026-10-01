# GameFyndr: importar jogos

Extensão de navegador que traz para o [GameFyndr](https://gamefyndr.com) a sua biblioteca, lista de desejos e conquistas da **Epic Games Store**, da **GOG** e da **PlayStation**, **sem que nenhuma senha, token ou cookie saia do seu navegador**.

## Por que uma extensão

Nenhuma dessas três lojas oferece a sites comuns um jeito oficial de ler a biblioteca de alguém. A Epic, por exemplo, tem um login oficial, mas ele só libera nome e ID da conta; a permissão de biblioteca existe só para parceiros dela.

O caminho que funciona é o mesmo que o Playnite, o Heroic e o Legendary usam há anos: os mesmos acessos que os aplicativos oficiais usam. O que faz esses programas serem aceitáveis é que **o acesso fica no seu computador**, não no servidor de outra pessoa. Esta extensão segue o mesmo modelo, dentro do navegador.

## O que acontece quando você clica em "Importar"

1. A extensão usa o login que você **já tem neste navegador** naquela loja. Se você não estiver logado, ela para e avisa.
2. Lê sua biblioteca, a lista de desejos e as conquistas (ou troféus) dos jogos que você jogou.
3. **Descarta o acesso**, sempre, inclusive se algo der errado no meio:
   - **Epic**: troca o login por uma sessão do launcher, que fica só na memória e é **encerrada na própria Epic** no fim.
   - **PlayStation**: troca o login por tokens que ficam só na memória e somem no fim. Nada é salvo. (A Sony não oferece um jeito de encerrar o token por fora; ele simplesmente nunca sai da extensão.)
   - **GOG**: não existe token. A extensão faz as leituras com o cookie que o próprio navegador já manda para a GOG, e nunca lê esse cookie.
4. Entrega à página do GameFyndr **só a lista de jogos** (nome, id da loja, capa, tempo jogado, conquistas). A página envia essa lista ao GameFyndr.

O servidor do GameFyndr nunca recebe nenhuma credencial dessas lojas.

## Permissões, uma por uma

| Permissão | Para quê |
|---|---|
| `www.epicgames.com` | Pedir o código de autorização da Epic com o seu login. |
| `account-public-service-prod03.ol.epicgames.com` | Trocar o código pela sessão e encerrar a sessão no fim. |
| `library-service.live.use1a.on.epicgames.com` | Ler a biblioteca e o tempo de jogo da Epic. |
| `launcher.store.epicgames.com` | Ler nomes dos jogos, a lista de desejos e as conquistas da Epic. |
| `catalog-public-service-prod06.ol.epicgames.com` | Reserva para jogos que saíram da loja da Epic. |
| `embed.gog.com` | Ler o perfil, a biblioteca e a lista de desejos da GOG. |
| `ca.account.sony.com` | Pedir a autorização da PlayStation com o seu login. |
| `m.np.playstation.com` | Ler o perfil, os jogos jogados e os troféus da PlayStation. |
| `declarativeNetRequestWithHostAccess` | Enviar às APIs das lojas os cabeçalhos que os aplicativos oficiais enviam. A regra vale só para as requisições da extensão (nunca para as suas abas) e só enquanto a importação roda. |
| `webRequest` | Só na PlayStation: o código de autorização vem num redirecionamento que o navegador esconde de quem fez o pedido. A extensão lê esse redirecionamento, só no endereço de autorização da Sony e só em requisições dela mesma. |
| Script em `gamefyndr.com` | Uma "ponte" que deixa a página do GameFyndr pedir a importação e receber a lista. Ela não lê nada da página. |

A extensão não pede acesso a nenhum outro site, não lê suas abas e não tem armazenamento.

## Código

- `src/background.ts`: as importações (passos 1 a 4), uma por loja.
- `src/ponte.ts`: a ponte com a página do GameFyndr.
- `src/vendor/`: a leitura de cada loja, **o mesmo código** que o servidor do GameFyndr usava antes da extensão.

O pacote instalado não é minificado: dá para abrir os arquivos da extensão e comparar com este repositório.

## Riscos que continuam existindo

- **É acesso não oficial.** Contraria os termos dessas lojas, como Playnite e Heroic. Não conhecemos caso de banimento por isso, mas não é garantia.
- **Durante a importação, o acesso é o mesmo do aplicativo oficial**, não só leitura. Por isso ele dura só os minutos da importação e é descartado no fim.
- **Você confia nas atualizações desta extensão.** É por isso que o código é aberto e o histórico de versões é público.

## Como compilar

```bash
npm install
npm run build        # dist/chrome e dist/firefox, só gamefyndr.com
npm run build:dev    # idem, aceitando também http://localhost:3001
```

Para instalar sem a loja: no Chrome, abra `chrome://extensions`, ligue o "Modo do desenvolvedor", clique em "Carregar sem compactação" e escolha `dist/chrome`. No Firefox, `about:debugging` > "Este Firefox" > "Carregar extensão temporária" e escolha `dist/firefox/manifest.json`.

## Licença

MIT. Ver [LICENSE](LICENSE).
