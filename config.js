const config = {
    goodreads: {
        url: 'https://www.goodreads.com/quotes/search?',
        maxpages: 100 // max number of pages to process for a word
    },
    db: {
        dbpath: './data',
        port: 27017,
        name: 'quotes'
    },
    // wait interval (in milliseconds) for preventing ddos
    wait: {
        lower: 10,
        upper: 100
    },
    // words to start searching from
    startwords: ['everything', 'you', 'can', 'imagine', 'is', 'real'],
    // characters to remove when trim words
    punctuation: ' .,!?\'\"“”‘’()-:;…'
};

module.exports = config;
