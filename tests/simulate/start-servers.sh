#!/bin/bash
# Starts the three stand-ins and the app preview. Logs go to $WORK/data/*.out
export WORK=/private/tmp/claude-501/-Users-mboryczka-Desktop-Projects-french-flashcards/e5b7f33f-5063-4b70-b9d7-e01e98da6778/scratchpad/fsrs-test
export NO_PROXY='*'
cd $WORK
nohup node servers/db-standin.mjs >> data/db.out 2>&1 < /dev/null &
echo $! > data/db.pid
nohup node servers/api-server.mjs >> data/api.out 2>&1 < /dev/null &
echo $! > data/api.pid
nohup node servers/claude-standin.mjs >> data/claude.out 2>&1 < /dev/null &
echo $! > data/claude.pid
cd $WORK/app
nohup npx vite preview --port 5190 --strictPort --host 127.0.0.1 >> $WORK/data/preview.out 2>&1 < /dev/null &
echo $! > $WORK/data/preview.pid
