'use strict';

var rangeParser = require('range-parser'),
  pump = require('pump'),
  _ = require('lodash'),
  express = require('express'),
  multipart = require('connect-multiparty'),
  fs = require('fs'),
  archiver = require('archiver'),
  store = require('./store'),
  progress = require('./progressbar'),
  stats = require('./stats'),
  api = express();

api.use(express.json());
api.use(express.logger('dev'));
api.use(function (req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'OPTIONS, POST, GET, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

function serialize(torrent) {
  if (!torrent.torrent) {
    return { infoHash: torrent.infoHash };
  }
  var pieceLength = torrent.torrent.pieceLength;

  return {
    infoHash: torrent.infoHash,
    name: torrent.torrent.name,
    length: torrent.torrent.length,
    interested: torrent.amInterested,
    ready: torrent.ready,
    files: torrent.files.map(function (f) {
      // jshint -W016
      var start = f.offset / pieceLength | 0;
      var end = (f.offset + f.length - 1) / pieceLength | 0;

      return {
        name: f.name,
        path: f.path,
        link: '/torrents/' + torrent.infoHash + '/files/' + encodeURIComponent(f.path),
        length: f.length,
        offset: f.offset,
        selected: torrent.selection.some(function (s) {
          return s.from <= start && s.to >= end;
        })
      };
    }),
    progress: progress(torrent.bitfield.buffer)
  };
}

function findTorrent(req, res, next) {
  var torrent = req.torrent = store.get(req.params.infoHash);
  if (!torrent) {
    return res.send(404);
  }
  next();
}

api.get('/torrents', function (req, res) {
  res.send(store.list().map(serialize));
});

api.post('/torrents', function (req, res) {
  store.add(req.body.link, function (err, infoHash) {
    if (err) {
      console.error(err);
      res.send(500, err);
    } else {
      res.send({ infoHash: infoHash });
    }
  });
});

api.post('/upload', multipart(), function (req, res) {
  var file = req.files && req.files.file;
  if (!file) {
    return res.send(500, 'file is missing');
  }
  store.add(file.path, function (err, infoHash) {
    if (err) {
      console.error(err);
      res.send(500, err);
    } else {
      res.send({ infoHash: infoHash });
    }
    fs.unlink(file.path, function (err) {
      console.error(err);
    });
  });
});

api.get('/torrents/:infoHash', findTorrent, function (req, res) {
  res.send(serialize(req.torrent));
});

api.post('/torrents/:infoHash/start/:index?', findTorrent, function (req, res) {
  var index = parseInt(req.params.index);
  if (index >= 0 && index < req.torrent.files.length) {
    req.torrent.files[index].select();
  } else {
    req.torrent.files.forEach(function (f) {
      f.select();
    });
  }
  res.send(200);
});

api.post('/torrents/:infoHash/stop/:index?', findTorrent, function (req, res) {
  var index = parseInt(req.params.index);
  if (index >= 0 && index < req.torrent.files.length) {
    req.torrent.files[index].deselect();
  } else {
    req.torrent.files.forEach(function (f) {
      f.deselect();
    });
  }
  res.send(200);
});

api.post('/torrents/:infoHash/pause', findTorrent, function (req, res) {
  req.torrent.swarm.pause();
  res.send(200);
});

api.post('/torrents/:infoHash/resume', findTorrent, function (req, res) {
  req.torrent.swarm.resume();
  res.send(200);
});

api.delete('/torrents/:infoHash', findTorrent, function (req, res) {
  store.remove(req.torrent.infoHash);
  res.send(200);
});

api.get('/torrents/:infoHash/stats', findTorrent, function (req, res) {
  res.send(stats(req.torrent));
});

api.get('/torrents/:infoHash/files', findTorrent, function (req, res) {
  var torrent = req.torrent;
  var proto = req.get('x-forwarded-proto') || req.protocol;
  var host = req.get('x-forwarded-host') || req.get('host');
  res.setHeader('Content-Type', 'application/x-mpegurl; charset=utf-8');
  res.attachment(torrent.torrent.name + '.m3u');
  res.send('#EXTM3U\n' + torrent.files.map(function (f) {
      return '#EXTINF:-1,' + f.path + '\n' +
        proto + '://' + host + '/torrents/' + torrent.infoHash + '/files/' + encodeURIComponent(f.path);
    }).join('\n'));
});

api.all('/torrents/:infoHash/files/:path([^"]+)', findTorrent, function (req, res) {
  var torrent = req.torrent, file = _.find(torrent.files, { path: req.params.path });

  if (!file) {
    return res.send(404);
  }

  if (typeof req.query.ffmpeg !== 'undefined') {
    return require('./ffmpeg')(req, res, torrent, file);
  }

  var range = req.headers.range;
  range = range && rangeParser(file.length, range)[0];
  res.setHeader('Accept-Ranges', 'bytes');
  res.type(file.name);
  req.connection.setTimeout(3600000);

  if (!range) {
    res.setHeader('Content-Length', file.length);
    if (req.method === 'HEAD') {
      return res.end();
    }
    return pump(file.createReadStream(), res);
  }

  res.statusCode = 206;
  res.setHeader('Content-Length', range.end - range.start + 1);
  res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + file.length);

  if (req.method === 'HEAD') {
    return res.end();
  }
  pump(file.createReadStream(range), res);
});

api.get('/torrents/:infoHash/archive', findTorrent, function (req, res) {
  var torrent = req.torrent;

  res.attachment(torrent.torrent.name + '.zip');
  req.connection.setTimeout(3600000);

  var archive = archiver('zip');
  archive.on('warning', function (err) {
    console.error(err);
  });
  archive.on('error', function (err) {
    throw err;
  });

  pump(archive, res);

  torrent.files.forEach(function (f) {
    archive.append(f.createReadStream(), { name: f.path });
  });
  archive.finalize();
});

//---------- Additional adapter part -----------
const uniqid = require('uniqid');
const QRCode = require('qrcode');

//----------- get self ip --------------------//
const os = require('os');
const ifaces = os.networkInterfaces();

const localIPhandle = () => {
    let localIP = []

    Object.keys(ifaces).forEach(function (ifname) {
      var alias = 0;
    
      ifaces[ifname].forEach(function (iface) {
        if ('IPv4' !== iface.family || iface.internal !== false) {
          //logger.debug(`Skip over internal (i.e. 127.0.0.1) and non-ipv4 addresses`)
          return null;
        }       
        if (alias >= 1) {
          //logger.debug(`This single interface has multiple ipv4 addresses: ${ifname}:${alias}, ${iface.address}`)
          localIP.push(iface.address);
        } else {
          //logger.debug(`This interface has only one ipv4 address: ${ifname}, ${iface.address}`)
          localIP.push(iface.address);
        }
        ++alias;
      });
    });
    return localIP.length ? localIP[0] : null;
}

const localIP = localIPhandle()
//--------------------------------------------//
const account =  require('../../config/account.json');
const httpRequest = require('request');

let selfUID = account.authorization.uid;

const pingTTL = (uri) => {
  setInterval(()=>{
    httpRequest
        .get(uri)
        .on('response', (res) => {
            //logger.debug(`Proxy ping running`)
            console.debug(`Proxy ping running for ${selfUID}`)
        })
        .on('error', (err) => {
            //logger.error(`Proxy ping error:${err}`)
            console.debug(`Proxy ping error:${err}`)
        })
  },60000)
}

const registration = () => {
  httpRequest
    .post(`${account.server}${account.register}`, {
      body: {
        'name': account.authorization.name,
        'pswd': account.authorization.pswd,
        'type': 'proxy',
        "selfip": localIP ? localIP : localIPhandle()
      },
      json: true
      },(err, httpResponse, body) => {
        if (err) {
          console.error('signin request failed:', err);
          return setTimeout(registration,10000)
        }
        if (body.UID) {
            selfUID = body.UID
            pingTTL(`${account.server}${account.pingURI}${selfUID}`)
            console.log('signin successful! :', selfUID);
        } else {
           console.error(`Your need register: ${account.signup}`)
        }
    });
}

registration()
//--------------- stream handle ---------------//

const streamHandler = (req, res) => {
               
    if(!req.query.src) {
        logger.warn(`Source File skip: ${ req.query.src }`);  
        return res.status(404).send();
    }

    const path = req.query.src
    
    fs.stat(path, function(err, stats) {
        if (err) {
          if (err.code === 'ENOENT') {
              logger.warn(`File not exist: ${ path }`);  
              return res.status(404).send();
          }
        }
               
        const fileSize = fs.statSync(path).size
        const range = req.headers.range              
    
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-")
            const start = parseInt(parts[0], 10)
            const end = parts[1]
                ? parseInt(parts[1], 10)
                : fileSize-1
        
            const chunksize = (end-start)+1
            const file = fs.createReadStream(path, {start, end})
            
            const head = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'video/mp4',
            }
        
            logger.debug('Range: %d-%d', start, end);
        
            res.writeHead(206, head)
            file.pipe(res)
        } else {
            const head = {
                'Content-Length': fileSize,
                'Content-Type': 'video/mp4',
            }
            res.writeHead(200, head)
            fs.createReadStream(path).pipe(res)
        }  
    })                  
}
//-------------------------------------------//
let Session = {}

api
  .get('/screen',(req,res) => { 
    const sid = uniqid()
    const url = localIP ? localIP : localIPhandle()
    if (url) {
        QRCode.toDataURL(`${url}:9000/remote/${sid}`)
        .then(url => {           
            if (!Session[sid]) {
                Session[sid] = {}
                Session[sid].playerID = sid
            }    
            const page = 'screen.ejs'  
            res.render(page, {
                SID:  sid,
                QRCode: url
            });      
            //logger.debug(`Create Session: ${sid}`)   
        })
        .catch(err => {
            //logger.error(`QRCode generation error: ${err}`)
            res.status(500).send({status: 'Server QRCode generation error'})
        })    
    } else {
        //logger.error(`Server cannot detect local IP`)
        res.status(500).send({status: 'Server can`t detect local IP'})
    }          
  })
  .get('/remote/:sid', (req, res) => { 
    if (req.params.sid && Session[req.params.sid]) {          
      Session[req.params.sid].joystickID = req.params.sid      
      res.render('remote.ejs', {
          SID:  Session[req.params.sid].joystickID
      });           
      //logger.debug(`Pair Remote to Session: ${req.params.sid}`)       
    } else {
      //logger.warn(`Session Not Found`)
      res.status(404).send({status: 'Session Not Found'});
    }    
  })
  .post('/control/:sid', (req, res) => { 
    if (req.params.sid && Session[req.params.sid]) {
      if (Session[req.params.sid].screen) {
          const subres = Session[req.params.sid].screen
          subres.status(200).send({
            stream: {
                file: req.body.file,
                cmd : req.body.cmd
            }})
          delete Session[req.params.sid].screen
          console.debug(`Remote publish to screen`)
          res.status(200).send({status: 'Complete'})
      } else {
          res.status(102).send({status: 'Processing'})
      }   
    } else {
      res.status(404).send({status: 'Session Not Found'})
    }
  })
  .get('/leave/:sid', (req,res) => {
    //logger.debug(`Player leave: ${req.params.sid}`)
    if (req.params.sid && Session[req.params.sid]) {      
        delete Session[req.params.sid]
        res.status(200).send({status: 'OK'});
    } else {
        res.status(404).send({status: 'Session Not Found'});
    }
  })
  .get('/unpair/:sid', (req,res) => {
      //logger.debug(`Joystick unpair: ${req.params.sid}`)
      if (req.params.sid && Session[req.params.sid]) {
          if (Session[req.params.sid].joystickID) {
              Session[req.params.sid].command = {
                cmd : 'unpair'
              }    
              delete Session[req.params.sid].joystickID
              res.status(200).send({status: 'OK'});
          } else 
              res.status(404).send({status: 'Joystick Not Paired'});
      } else {
          res.status(404).send({status: 'Session Not Found'});
      }      
  })
  .get('/proxy/:uid', (req, res) => {
      if (!selfUID) {
          selfUID = req.params.uid
          logger.debug(`Keep self UID: ${selfUID}`)
          pingTTL(`${account.server}${account.pingURI}${selfUID}`)
      }
      res.status(200).send({status: 'OK'});
  })
  .get('/subscribe/:sid', (req, res) => {
    if (req.params.sid && Session[req.params.sid]) {
        Session[req.params.sid].screen = res   
    } else {
      res.status(404).send({status: 'Session Not Found'})
    }    
  })
  .get('/stream', (req, res) => streamHandler(req, res))


module.exports = api;
