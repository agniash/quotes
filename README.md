# quotes

Prerequisites: node (>= 9.2.0), mongodb

Installation: after installing node and mongodb, type `npm install` in terminal

Usage: type `node main.js` or `./run` in terminal (you'll see the help message)

Examples:

`./run -c 10000` -- collect around 10000 quotes

`./run -i` -- show the number of collected quotes and words

`./run -w bingo -p 3` -- collect the first 3 pages of quotes for the word 'bingo'

`./run -s 23` -- collect quotes for some 23 words from the data base

`./run -j quotes.json` -- export collected quotes in json format to quotes.json file

`./run -d dump_dir` -- dump the data base

`./run --clear` -- delete all data from data base
