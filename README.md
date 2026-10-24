# zdrofit-sniper

Books Zdrofit weekly classes for several users at the second the booking window opens.

Work in progress.

## Usage

```sh
pnpm install
pnpm build
pnpm sniper setup    # interactive wizard: users and snipers
pnpm sniper daemon   # sleep until the next opening, then book
```

State lives in `data/` (git-ignored). Never commit it.

## License

MIT — see [LICENSE](./LICENSE).
