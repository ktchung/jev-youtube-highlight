.PHONY: setup helper extension check browser-check

setup:
	uv sync --project helper --extra dev
	npm --prefix extension ci

helper:
	uv run --project helper jev-helper

extension:
	npm --prefix extension run build

check:
	uv run --project helper --extra dev pytest helper/tests
	npm --prefix extension run check

browser-check: extension
	node scripts/browser-smoke.mjs
