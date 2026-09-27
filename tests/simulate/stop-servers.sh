#!/bin/bash
WORK=/private/tmp/claude-501/-Users-mboryczka-Desktop-Projects-french-flashcards/e5b7f33f-5063-4b70-b9d7-e01e98da6778/scratchpad/fsrs-test
for n in preview claude api db; do
  if [ -f $WORK/data/$n.pid ]; then kill $(cat $WORK/data/$n.pid) 2>/dev/null; rm -f $WORK/data/$n.pid; fi
done
