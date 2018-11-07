'use strict';

var Entities = require("entities");
var FS = require('fs');
var url = require('url');
var XML2JS = require('xml2js');
const moment = require('moment')
const _get = require('lodash.get')

var HTTP = require('http');
var HTTPS = require('https');

const RFC3339 = 'YYYY-MM-DDTHH:mm:ssZ'

var Parser = module.exports = {};

var FEED_FIELDS = [
  ['author', 'creator'],
  ['dc:publisher', 'publisher'],
  ['dc:creator', 'creator'],
  ['dc:source', 'source'],
  ['dc:title', 'title'],
  ['dc:type', 'type'],
  'title',
  'description',
  'author',
  'pubDate',
  'webMaster',
  'managingEditor',
  'generator',
  'link',
];

var ITEM_FIELDS = [
  ['author', 'creator'],
  ['dc:creator', 'creator'],
  ['dc:date', 'date'],
  ['dc:language', 'language'],
  ['dc:rights', 'rights'],
  ['dc:source', 'source'],
  ['dc:title', 'title'],
  'title',
  'link',
  'pubDate',
  'author',
  'content:encoded',
  'enclosure',
  'dc:creator',
  'dc:date',
];

var mapItunesField = function(f) {
  return ['itunes:' + f, f];
}

var PODCAST_FEED_FIELDS = ([
  'author',
  'subtitle',
  'summary',
  'explicit'
]).map(mapItunesField);

var PODCAST_ITEM_FIELDS = ([
  'author',
  'subtitle',
  'summary',
  'explicit',
  'duration',
  'image'
]).map(mapItunesField);


var stripHtml = function(str) {
  return str.replace(/<(?:.|\n)*?>/gm, '');
}

var getSnippet = function(str) {
  return Entities.decode(stripHtml(str)).trim();
}

var getContent = function(content) {
  if (typeof content._ === 'string') {
    return content._;
  } else if (typeof content === 'object') {
    var builder = new XML2JS.Builder({headless: true, explicitRoot: true, rootName: 'div', renderOpts: {pretty: false}});
    return builder.buildObject(content);
  } else {
    return content;
  }
}

var parseAtomFeed = function(xmlObj, options, callback) {
  var feed = xmlObj.feed;
  var json = {version: '1.0.0', items: []};
  if (feed.link) {
    if (feed.link[0] && feed.link[0].$.href) json.home_page_url = feed.link[0].$.href;
    if (feed.link[1] && feed.link[1].$.href) json.feed_url = feed.link[1].$.href;
  }
  if (feed.title) {
    var title = feed.title[0] || '';
    if (title._) title = title._
    if (title) json.title = title;
  }
  var entries = feed.entry;
  (entries || []).forEach(function (entry) {
    var item = {};
    if (entry.title) {
      var title = entry.title[0] || '';
      if (title._) title = title._;
      if (title) item.title = title;
    }
    if (entry.link && entry.link.length) item.url = entry.link[0].$.href;
    if (entry.updated && entry.updated.length) item.date_published = moment.utc(entry.updated[0]).format(RFC3339);
    if (entry.author && entry.author.length) item.author = {name: entry.author[0].name[0]};
    if (entry.content && entry.content.length) {
      item.content_html = getContent(entry.content[0]);
    }
    if (entry.id) {
      item.id = entry.id[0];
    }
    json.items.push(item);
  });
  callback(null, json);
}

var parseRSS1 = function(xmlObj, options, callback) {
  xmlObj = xmlObj['rdf:RDF'];
  var channel = xmlObj.channel[0];
  var items = xmlObj.item;
  return parseRSS(channel, items, options, callback);
}

var parseRSS2 = function(xmlObj, options, callback) {
  var channel = xmlObj.rss.channel[0];
  var items = channel.item;
  return parseRSS(channel, items, options, function(err, data) {
    if (err) return callback(err);
    if (xmlObj.rss.$['xmlns:itunes']) {
      decorateItunes(data, channel);
    }
    callback(null, data);
  });
}

var parseRSS = function(channel, items, options, callback) {
  items = items || [];
  options.customFields = options.customFields || {};
  var itemFields = ITEM_FIELDS.concat(options.customFields.item || []);
  var feedFields = FEED_FIELDS.concat(options.customFields.feed || []);

  const feed_url = _get(channel, 'atom:link.$.href', null)
    || _get(channel, '$.rdf:about', null)

  var json = {
    version: "1.0.0",
    title: channel['title'][0],
    home_page_url: channel['link'][0],
    feed_url,
    items: []
  };

  if (channel['atom:link']) json.feed_url = channel['atom:link'][0].$.href;
  items.forEach(function(item) {
    var jsonItem = {};
    if (item.enclosure) {
        jsonItem.enclosure = item.enclosure[0].$;
        jsonItem.attachments = jsonItem.enclosure
    }
    if (item.description) {
      jsonItem.content_html = getContent(item.description[0]);
      jsonItem.summary = getSnippet(jsonItem.content_html);
    }
    if (item.title) {
      jsonItem.title = item.title[0]
    }
    if (item.link) {
      jsonItem.url = item.link[0]
    }
    if (item.guid) {
      jsonItem.id = _get(item, 'guid[0]._', null) || _get(item, 'guid[0]', null)
    }
    if (item.category) {
      jsonItem.tags = item.category
    }

    const date = _get(item, 'dc:date[0]', null)
      || _get(item, 'dcterms:issued[0]', null)
      || _get(item, 'pubDate[0]', null);
    if (date) {
      try {
        jsonItem.date_published = moment(date.trim()).format(RFC3339);
      } catch (e) {
        // Ignore bad date format
      }
    }
    json.items.push(jsonItem);
  })
  callback(null, json);
}

var copyFromXML = function(xml, dest, fields) {
  fields.forEach(function(f) {
    var from = f;
    var to = f;
    if (Array.isArray(f)) {
      from = f[0];
      to = f[1];
    }
    if (xml[from] !== undefined) dest[to] = xml[from][0];
  })
}

/**
 * Add iTunes specific fields from XML to extracted JSON
 *
 * @access public
 * @param {object} json extracted
 * @param {object} channel parsed XML
 */
var decorateItunes = function decorateItunes(json, channel) {
  var items = channel.item || [],
      entry = {};
  json.feed.itunes = {}

  if (channel['itunes:owner']) {
    var owner = {},
        image;

    if(channel['itunes:owner'][0]['itunes:name']) {
      owner.name = channel['itunes:owner'][0]['itunes:name'][0];
    }
    if(channel['itunes:owner'][0]['itunes:email']) {
      owner.email = channel['itunes:owner'][0]['itunes:email'][0];
    }
    if(channel['itunes:image']) {
      image = channel['itunes:image'][0].$.href
    }

    if(image) {
      json.feed.itunes.image = image;
    }
    json.feed.itunes.owner = owner;
  }

  copyFromXML(channel, json.feed.itunes, PODCAST_FEED_FIELDS);
  items.forEach(function(item, index) {
    var entry = json.feed.entries[index];
    entry.itunes = {};
    copyFromXML(item, entry.itunes, PODCAST_ITEM_FIELDS);
    var image = item['itunes:image'];
    if (image && image[0] && image[0].$ && image[0].$.href) {
      entry.itunes.image = image[0].$.href;
    }
  });
}

Parser.parseString = function(xml, options, callback) {
  if (!callback) {
    callback = options;
    options = {};
  }
  XML2JS.parseString(xml, function(err, result) {
    if (err) return callback(err);
    debugger
    if (result.feed) {
      return parseAtomFeed(result, options, callback)
    } else if (result.rss && result.rss.$.version && result.rss.$.version.indexOf('2') === 0) {
      return parseRSS2(result, options, callback);
    } else if (result['rdf:RDF']) {
      return parseRSS1(result, options, callback);
    } else {
      return callback(new Error("Feed not recognized as RSS 1 or 2."))
    }
  });
}

Parser.parseURL = function(feedUrl, options, callback) {
  if (!callback) {
    callback = options;
    options = {};
  }
  options.__redirectCount = options.__redirectCount || 0;
  if (options.maxRedirects === undefined) options.maxRedirects = 1;

  var xml = '';
  var get = feedUrl.indexOf('https') === 0 ? HTTPS.get : HTTP.get;
  var parsedUrl = url.parse(feedUrl);
  var req = get({
    auth: parsedUrl.auth,
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    path: parsedUrl.path,
    headers: {'User-Agent': 'rss-parser'}
  }, function(res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers['location']) {
      if (options.maxRedirects === 0) return callback(new Error("Status code " + res.statusCode));
      if (options.__redirectCount === options.maxRedirects) return callback(new Error("Too many redirects"));
      options.__redirectCount++;
      return Parser.parseURL(res.headers['location'], options, callback);
    }
    res.setEncoding('utf8');
    res.on('data', function(chunk) {
      xml += chunk;
    });
    res.on('end', function() {
      return Parser.parseString(xml, options, callback);
    })
  })
  req.on('error', callback);
}

Parser.parseFile = function(file, options, callback) {
  FS.readFile(file, 'utf8', function(err, contents) {
    return Parser.parseString(contents, options, callback);
  })
}
