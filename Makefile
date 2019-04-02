MINIFIER=closure-compiler --language_in=ECMASCRIPT5
#MINIFIER=cat

DEPS=libav/libav-1.0.4.1-fat.js \
	FileSaver.min.js \
	localforage.min.js

SRC=src/head.js \
	src/view.js \
	src/db.js \
	src/track.js \
	src/filters.js \
	src/main.js \
	src/tail.js

all: ennuizel.js ennuizel.min.js $(DEPS)

ennuizel.js: $(SRC)
	cat $(SRC) | cat src/license.js - > $@

ennuizel.min.js: $(SRC)
	cat $(SRC) | $(MINIFIER) | cat src/license.js - > $@

libav/libav-1.0.4.1-fat.js:
	echo 'You must copy or link a "fat" build of libav.js to the libav/ directory.'
	false

FileSaver.min.js:
	test -e node_modules/.bin/bower || npm install bower
	test -e bower_modules/file-saver/dist/FileSaver.min.js || ./node_modules/.bin/bower install file-saver
	( \
		printf '/*\n' ; \
		cat bower_components/file-saver/LICENSE.md ; \
		printf '*/\n' ; \
		cat bower_components/file-saver/dist/FileSaver.min.js \
	) > FileSaver.min.js

localforage.min.js:
	test -e node_modules/localforage/dist/localforage.min.js || npm install localforage
	cp node_modules/localforage/dist/localforage.min.js .

clean:
	rm -f ennuizel.js ennuizel.min.js

distclean: clean
	rm -rf bower_components node_modules FileSaver.min.js localforage.min.js