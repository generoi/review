/**
 * module dependencies
 */

var spawn = require('child_process').spawn
var crypto = require('crypto')
var mkdirp = require('mkdirp')
var path = require('path')
var EventEmitter = require('events').EventEmitter
var fs = require('fs')
var im = require('imagemagick')
var async = require('async')

/**
 * cache handling
 */

var caching = {}
var caches = new EventEmitter()

/**
 * fs shortcuts
 */

var script = __dirname + '/../script/rasterize.js'
var phantomjs_path = __dirname + '/../phantomjs'

/**
 * snapshot route
 */

module.exports = function (app) {
  var queue = async.queue(snapshot, app.get('concurrency'));

  function snapshot (task, cb) {
    var params = task.params;
    console.log('Screenshot request for ' + params.url);
    var ps = spawn(phantomjs_path, [
      script, params.url, params.resolution,
      params.wait, app.get('cut'), JSON.stringify(app.get('cookie'))
    ])

    ps.on('error', cb)

    var chunks = []
    ps.stdout.on('data', function (chunk) {
      chunks.push(chunk)
    })

    ps.on('exit', function () {
      console.log('Screenshot taken of ' + params.url);
      cb(null, new Buffer(chunks.join(''), 'base64'))
    })
  }
  
  return function (req, res, next) {
    if (!app.get('cache')) {
      console.log('use caching! @oxy');
      return queue.push(req.params, function (err, rasterized) {
        if (err) return next(err)
        res.set('Content-Type', 'image/png')
        res.send(rasterized)
      })
    }

    var hash = crypto
      .createHash('sha1')
      .update(req.params['url'])
      .update(req.params['resolution'])
      .update(req.params['wait'])
      .update(JSON.stringify(app.get('cache')))
      .update(JSON.stringify(app.get('cut')))
      .update(JSON.stringify(app.get('cookie')))
      .digest('hex')

    var dir = path.join(app.get('cache').dir, hash.slice(0, 2))
    var filename = path.join(dir, hash + '.png')

    function trim(filename, cb) {
      im.convert([filename, '-trim', filename], function(err) {
        if (err) return next(err);
        fs.readFile(filename, function(err, data) {
          if (err) return next(err);
          cb(data);
        });
      })
    }

    function createCache () {
      caching[hash] = true

      queue.push({ params: req.params }, function (err, rasterized) {
        if (err) return caching[hash] = false, next(err)

        mkdirp(dir, function () {
          fs.writeFile(filename, rasterized, function (err) {
            caching[hash] = false
            if (err) return next(err)

            trim(filename, function(trimmed) {
              res.set('Content-Type', 'image/png').end(trimmed)
              caches.emit(hash)
            });
          })
        })
      })
    }

    // refresh
    if ('refresh' in req.query) return createCache()

    // choose action based on cache file stat
    fs.stat(filename, function (err, stat) {
      // serve cache
      var cacheAge = Date.now() - app.get('cache').expires * 1000
      if (!err && stat.mtime >= cacheAge) return res.sendfile(filename)

      // prevent cache being recreated by multiple requests simultaneously
      if (caching[hash]) {
        return caches.once(hash, res.sendfile.bind(res, filename))
      }

      createCache()
    })
  }
}
