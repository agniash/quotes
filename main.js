const cheerio = require('cheerio');
const encodeurl = require('encodeurl');
const got = require('got');
const _ = require('lodash');
const progress = require('progress');
const cmd = require('commander');
const {MongoClient} = require('mongodb');
const {spawn} = require('child_process');
const mkdirp = require('mkdirp');
const hash = require('hash.js');
const config = require('./config');

let mongo;
let db;

const StartDB = async () => {
    mkdirp.sync(config.db.dbpath);
    mongo = spawn(`mongod --dbpath ${config.db.dbpath} --port ${config.db.port}`, [], {shell: true});
    while (!db) {
        try {
            db = await MongoClient.connect(`mongodb://localhost:${config.db.port}/${config.db.name}`);
        } catch (e) {}
    }
    const count = await db.collection('toprocesswords').count();
    if (count === 0) {
        const words = config.startwords.map(word => { return { 'value': word }; });
        await db.collection('toprocesswords').insertMany(words);
    }
};

const StopDB = async () => {
    await db.close();
    mongo.kill('SIGINT');
};

const CreateProgressBar = (pages) => {
    return new progress('[:bar] :percent', {incomplete: ' ', total: pages, width: 100});
};

const GetHash = (obj) => {
    return hash.sha512().update(JSON.stringify(obj)).digest('hex');
};

const QuoteToWords = (quote) => {
    const words = quote['text'].split(' ').map(word => _.trim(word, config.punctuation));
    return new Set(words);
};

const CollectWordsFromQuotes = (quotes) => {
    let words = new Set();
    _.each(quotes, quote => {
        words = new Set([...words, ...QuoteToWords(quote)]);
    });
    return [...words];
};

const GetExistingWords = (db, collectionName, words) => {
    return db.collection(collectionName)
    .find({ 'value': { $in: words } })
    .toArray()
    .then(existingWords => _.map(existingWords, 'value'));
};

const SaveWords = async (db, words) => {
    const wordsPair = await Promise.all([
        GetExistingWords(db, 'toskipwords', words),
        GetExistingWords(db, 'toprocesswords', words)
    ]);
    const words1 = new Set(wordsPair[0]);
    const words2 = new Set(wordsPair[1]);
    let wordsToSave = words.filter(word => !words1.has(word) && !words2.has(word));
    wordsToSave = wordsToSave.map(word => { return { 'value': word }; });
    if (!_.isEmpty(wordsToSave)) {
        return db.collection('toprocesswords').insertMany(wordsToSave);
    }
};

const SaveQuotes = async (db, quotes) => {
    const collection = db.collection('quotes');
	const updates = _.map(quotes, quote => {
		return collection.update(
			{ _id: GetHash(quote) },
			{ $setOnInsert: quote },
			{ upsert: true }
		)
	});
	const results = await Promise.all(updates);
    return _.sumBy(results, result => result.result.upserted ? 1 : 0);
};

const GetPagesCount = async (word) => {
    const url = config.goodreads.url + 'q=' + word;
	const response = await got(encodeurl(url));
    const $ = cheerio.load(response.body);
    const maxPages = _.parseInt($('.next_page').prev().text()) || 0;
    return Math.min(maxPages, config.goodreads.maxpages);
};

const Wait = () => {
	return new Promise(resolve => {
		const interval = _.random(config.wait.lower, config.wait.upper);
		setTimeout(() => resolve(), interval);
	});
};

const CollectQuotesForWordAndPage = async (db, word, page) => {
    const url = config.goodreads.url + 'q=' + word + '&page=' + page;
    const response = await got(encodeurl(url));
    let quotes = [];
    const $ = cheerio.load(response.body);
    $('.quoteDetails').each(function() {
        let quote = {};
        const quoteDetails = $(this);
        const parts = quoteDetails.find('.quoteText').html().split('<br>');
        quote['text'] = _.trim(_.trim(cheerio.load(parts[0]).text()), '“”');
        let author = '';
        let title = '';
        cheerio.load(parts[1])('.authorOrTitle').each(function(index) {
            const text = $(this).text();
            if (index == 0) {
                author = text;
            } else if (index == 1) {
                title = text;
            }
        });
        quote['author'] = author;
        quote['title'] = title;
        const quoteFooter = quoteDetails.find('.quoteFooter');
        let tags = [];
        quoteFooter.find('.left a').each(function() {
            tags.push($(this).text());
        });
        quote['tags'] = tags;
        quote['likes'] = _.parseInt(quoteFooter.find('.right a').text());
        quotes.push(quote);
    });
    const words = CollectWordsFromQuotes(quotes);
    await SaveWords(db, words);
    const count = await SaveQuotes(db, quotes);
    await Wait();
    return count;
};

const CollectQuotesForWord = async (db, word, minCount, bar) => {
    console.log(`\ncollecting quotes for the word \"${word}\"`);
	let count = 0;
	const pages = await GetPagesCount(word);
    bar = minCount ? bar : CreateProgressBar(pages);
    const {savedWord, savedPage} = await db.collection('wordpage').findOne() || {};
    let page = (word === savedWord) ? savedPage : 1;
    for (; page <= pages; page += 1) {
        const newCount = await CollectQuotesForWordAndPage(db, word, page);
        count += newCount;
        if (minCount) {
            bar.tick(newCount);
            if (count >= minCount) {
                await db.collection('wordpage').update({}, {'savedWord': word, 'savedPage': page}, {upsert: true});
                break;
            }
        } else {
            bar.tick();
        }
    }
    return {
        'count': count,
        'complete': (page >= pages)
    }
};

const ProcessWordFromDB = async (db, minCount, bar) => {
    const word = await db.collection('toprocesswords').findOne();
    const {count, complete} = await CollectQuotesForWord(db, word['value'], minCount, bar);
    if (complete) {
        await Promise.all([
            db.collection('toprocesswords').deleteOne(word),
            db.collection('toskipwords').insertOne(word)
        ]);
    }
    return count;
};

const ProcessWordsFromDB = async (db, count) => {
    for (let i = 0; i < count; i += 1) {
        const collected = await ProcessWordFromDB(db);
        console.log(`${collected} quotes collected`);
    }
    await PrintInfo(db);
};

const CollectQuotes = async (db, minCount) => {
    let count = 0;
    const bar = CreateProgressBar(minCount);
    while (count < minCount) {
        count += await ProcessWordFromDB(db, minCount - count, bar);
    }
    await PrintInfo(db);
    return count;
};

const PrintInfo = async (db) => {
    const quotes = await db.collection('quotes').count();
    const words = await db.collection('toprocesswords').count();
    console.log(`${quotes} quotes / ${words} words`);
};

const WaitProcess = (p) => {
    return new Promise(resolve => {
        p.on('exit', () => resolve());
    });
};

const ExportToJson = (path) => {
    return WaitProcess(spawn(`mongoexport --db quotes --collection quotes --out ${path}`, [], {shell: true}));
};

const DumpDB = (path) => {
    return WaitProcess(spawn(`mongodump --gzip --db quotes --out ${path}`, [], {shell: true}));
};

const Run = async () => {
    cmd
    .option('-c, --collect <n>', 'number of quotes to collect', parseInt)
    .option('-s, --some-words <n>', 'number of search words from data base to collect quotes for', parseInt)
    .option('-w, --word <string>', 'word to collect quotes for')
    .option('-p, --pages <n>', 'max pages to parse (must be <= 100, default = 100)', parseInt)
    .option('-i, --info', 'number of quotes and words in data base')
    .option('-j, --json <path>', 'filename for json export of quotes')
    .option('-d, --dump <path>', 'dirname for data base dump')
    .option('--clear', 'clear database')
    .parse(process.argv);

    if (!process.argv.slice(2).length) {
        cmd.outputHelp();
        return;
    }

    await StartDB();

    if (cmd.json) {
        await ExportToJson(cmd.json);
    }

    if (cmd.dump) {
        await DumpDB(cmd.dump);
    }
    
    if (cmd.pages) {
        config.goodreads.maxpages = Math.min(cmd.pages, 100);
    }

    try {
        if (cmd.collect) {
            await CollectQuotes(db, cmd.collect);
        } else if (cmd.someWords) {
            await ProcessWordsFromDB(db, cmd.someWords);
        } else if (cmd.word) {
            await CollectQuotesForWord(db, cmd.word);
        } else if (cmd.info) {
            await PrintInfo(db);
        } else if (cmd.clear) {
            await db.dropDatabase();
        }
    } catch (error) {
        console.log(error);
    }

    await StopDB();
};

Run();
