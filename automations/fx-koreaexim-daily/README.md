# Korea Eximbank Daily FX

Captures Korea Eximbank `AP01` exchange-rate data into a finalized raw bundle.

Required env:

- `FX_KOREAEXIM_AUTHKEY`
- `OBSIDIAN_VAULT_PATH`

Optional env:

- `FX_KOREAEXIM_API_BASE_URL`
- `FX_CURRENCIES` comma-separated target `CUR_UNIT` values, or `all`
- `FX_SEARCH_DATE` fixed `YYYYMMDD` override for manual backfill/tests
- `FX_KOREAEXIM_FIXTURE_PATH` local JSON fixture path for tests
- `FX_SKIP_EMPTY_BUNDLE=1` to skip raw/wiki output when the API returns no source rows
- `WIKI_INGEST_COMMAND` to trigger LLMwiki ingest after bundle finalization
