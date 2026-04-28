# Automation Modules

Product-owned one-shot automation modules live under this directory.

Each module is a folder with:

```text
<module>/
  manifest.json
  run.mjs
  README.md
```

The stable operator entrypoint is:

```bash
npm run tlgi -- automation list
npm run tlgi -- automation run <module-id> --force
```

Do not add one npm script per automation module. Register modules by adding a manifest folder here.
