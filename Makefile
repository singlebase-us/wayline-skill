.PHONY: build build-one check test dev prod

build:
	@if [ "$(words $(MAKECMDGOALS))" -ne 2 ]; then printf '%s\n' 'usage: make build <dev|prod>'; exit 2; fi
	@case "$(word 2,$(MAKECMDGOALS))" in dev|prod) ;; *) printf '%s\n' 'usage: make build <dev|prod>'; exit 2;; esac
	@$(MAKE) --no-print-directory build-one BUILD_ENV=$(word 2,$(MAKECMDGOALS))

build-one:
	@case "$(BUILD_ENV)" in \
		dev) npm run build:dev ;; \
		prod) npm run build:prod ;; \
		*) printf '%s\n' 'BUILD_ENV must be dev or prod'; exit 2 ;; \
	esac

check:
	npm run check

test:
	npm test

dev prod:
	@:
