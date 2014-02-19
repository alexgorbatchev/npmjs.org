var updates = exports

updates.delete = function (doc, req) {
  if (req.method !== "DELETE")
    return [ { _id: ".error.", forbidden: "Method not allowed" },
             { error: "method not allowed" } ]

  require("monkeypatch").patch(Object, Date, Array, String)
  var t = doc.time || {}
  t.unpublished = {
    name: req.userCtx.name,
    time: new Date().toISOString()
  }
  return [ {
    _id: doc._id,
    _rev: doc._rev,
    name: doc._id,
    time: t
  }, JSON.stringify({ ok: "deleted" }) ]
}

// There are three types of things that will be PUT into here.
// 1. "root doc" with no versions
// 2. "root + version"
// 3. "root + versions + inline attachments"
// 4. query.version="some-tag", body="1.2.3"
// 5. query.version="1.2.3", body={"some":"doc"}
//
// For (4), we only need to update dist-tags.
// For (5), we only need to add the new version, and time.
//
// In the first three cases, what we want to do is:
// 1. Merge new versions into old.
// 2. Set the _npmUser on any new versions to req.userCtx.name
// 3. Set time.modified and time[newVersion] to now
// 4. If there's no time.created, set that to now
// 5. If there are no glaring problems, set the _rev on the return doc to
//    the _rev of the existing doc (no 409 PUTGETPUT dance)
//
// In all cases, make sure that the "latest" version gets its junk copied
// onto the root doc.
updates.package = function (doc, req) {
  require("monkeypatch").patch(Object, Date, Array, String)
  var semver = require("semver")
  var valid = require("valid")
  var README_MAXLEN = 64 * 1024
  var body = JSON.parse(req.body)
  var deep = require("deep")
  var deepEquals = deep.deepEquals

  // Sure would be nice if there was an easy way to toggle this in
  // couchdb somehow.
  var DEBUG = false
  var d
  var output = []
  if (typeof console === 'object')
    d = console.error
  else if (DEBUG)
    d = function() { output.push([].slice.apply(arguments)) }
  else
    d = function() {}

  if (!doc)
    return newDoc(body)
  else if (req.query.version)
    return legacyUpdate(doc, body, req.query.version)
  else
    return updateDoc(body, doc)

  // unreachable
  return error("bug in update function. please report this.")


  ////////////
  // methods

  function legacyUpdate(doc, body, query) {
    // we know that there's already a document to merge into.
    // Figure out what we're trying to add into it.
    //
    // legacy npm clients would PUT the version to /:pkg/:version
    // tagging is done by PUT /:pkg/:tag with a "version" string
    if (typeof body === "string") {
      var tag = query
      var ver = body
      return addTag(tag, ver)
    }

    // adding a new version.
    return addNewVersion(query, body)
  }

  // return error(reason) to abort at any point.
  // the vdu will not allow this _id, and will throw
  // the "forbidden" value.
  function error (reason) {
    if (output.length) {
      reason += "\n" + output.map(function(n) {
        return n.map(function(a) {
          return JSON.stringify(a)
        }).join(" ")
      }).join("\n")
    }
    return [{
      _id: ".error.",
      forbidden: reason
    }, JSON.stringify({
      forbidden: reason
    })]
  }

  // Copy relevant properties from the "latest" published version to root
  function latestCopy(doc) {
    d('latestCopy', doc['dist-tags'])

    if (!doc['dist-tags'] || !doc.versions)
      return

    var copyFields = [
      "description",
      "homepage",
      "keywords",
      "repository",
      "contributors",
      "author",
      "bugs",
      "license"
    ]

    var latest = doc.versions && doc.versions[doc["dist-tags"].latest]
    if (latest && typeof latest === "object") {
      copyFields.forEach(function(k) {
        if (!latest[k])
          delete doc[k]
        else
          doc[k] = latest[k]
      })
    }
  }

  // Clean up excessive readmes and move to root of doc.
  function readmeTrim(doc) {
    var changed = false
    var readme = doc.readme || ''
    var readmeFilename = doc.readmeFilename || ''
    if (doc['dist-tags'] && doc['dist-tags'].latest) {
      var latest = doc.versions[doc['dist-tags'].latest]
      if (latest && latest.readme) {
        readme = latest.readme
        readmeFilename = latest.readmeFilename || ''
      }
    }

    for (var v in doc.versions) {
      // If we still don't have one, just take the first one.
      if (doc.versions[v].readme && !readme)
        readme = doc.versions[v].readme
      if (doc.versions[v].readmeFilename && !readmeFilename)
        readmeFilename = doc.versions[v].readmeFilename

      if (doc.versions[v].readme)
        changed = true

      delete doc.versions[v].readme
      delete doc.versions[v].readmeFilename
    }

    if (readme && readme.length > README_MAXLEN) {
      changed = true
      readme = readme.slice(0, README_MAXLEN)
    }
    doc.readme = readme
    doc.readmeFilename = readmeFilename

    return changed
  }

  // return ok(result, message) to exit successfully at any point.
  // Does some final data integrity cleanup stuff.
  function ok (doc, message) {
    delete doc.mtime
    delete doc.ctime
    var time = doc.time = doc.time || {}
    time.modified = (new Date()).toISOString()
    time.created = time.created || time.modified
    for (var v in doc.versions) {
      var ver = doc.versions[v]
      delete ver.ctime
      delete ver.mtime
      time[v] = time[v] || (new Date()).toISOString()
    }
    readmeTrim(doc)
    latestCopy(doc)

    if (!doc.maintainers)
      return error("no maintainers?\n" + JSON.stringify(doc))

    if (output.length) {
      message += "\n" + output.map(function(n) {
        return n.map(function(a) {
          return JSON.stringify(a)
        }).join(" ")
      }).join("\n")
    }
    return [doc, JSON.stringify({ok:message})]
  }


  // Create new package doc
  function newDoc (doc) {
    if (!doc._id) doc._id = doc.name
    if (!doc.versions) doc.versions = {}
    var latest
    for (var v in doc.versions) {
      if (!semver.valid(v, true))
        return error("Invalid version: "+JSON.stringify(v))
      var p = doc.versions[v]
      if (p.version !== v)
        return error("Version mismatch: "+JSON.stringify(v)+
                     " !== "+JSON.stringify(p.version))
      if (!valid.name(p.name))
        return error("Invalid name: "+JSON.stringify(p.name))
      latest = semver.clean(v, true)
    }
    if (!doc['dist-tags']) doc['dist-tags'] = {}
    if (latest) doc["dist-tags"].latest = latest

    return ok(doc, "created new entry")
  }

  function addTag(tag, ver) {
    // tag
    if (!semver.valid(ver)) {
      return error("setting tag "+tag+" to invalid version: "+ver)
    }
    if (!doc.versions || !doc.versions[ver]) {
      return error("setting tag "+tag+" to unknown version: "+ver)
    }
    doc["dist-tags"][tag] = semver.clean(ver, true)
    return ok(doc, "updated tag")
  }

  function addNewVersion(ver, body) {
    if (typeof body !== "object" || !body) {
      return error("putting invalid object to version "+req.query.version)
    }

    if (!semver.valid(ver, true)) {
      return error("invalid version: "+ver)
    }

    if (doc.versions) {
      if ((ver in doc.versions) || (semver.clean(ver, true) in doc.versions)) {
        // attempting to overwrite an existing version.
        // not allowed
        return error("cannot modify existing version")
      }
    }

    if (body.name !== doc.name || body.name !== doc._id) {
      return error( "Invalid name: "+JSON.stringify(body.name))
    }

    body.version = semver.clean(body.version, true)
    ver = semver.clean(ver, true)
    if (body.version !== ver) {
      return error( "version in doc doesn't match version in request: "
                  + JSON.stringify(body.version)
                  + " !== " + JSON.stringify(ver) )
    }

    body._id = body.name + "@" + body.version
    d("set body.maintainers to doc.maintainers", doc.maintainers)
    body.maintainers = doc.maintainers
    body._npmUser = body._npmUser || { name: req.userCtx.name }

    if (body.publishConfig && typeof body.publishConfig === 'object') {
      Object.keys(body.publishConfig).filter(function (k) {
        return k.match(/^_/)
      }).forEach(function (k) {
        delete body.publishConfig[k]
      })
    }

    var tag = req.query.tag
            || (body.publishConfig && body.publishConfig.tag)
            || body.tag
            || "latest"

    if (!req.query.pre)
      doc["dist-tags"][tag] = body.version
    if (!doc["dist-tags"].latest)
      doc["dist-tags"].latest = body.version
    doc.versions[ver] = body
    doc.time = doc.time || {}
    doc.time[ver] = (new Date()).toISOString()
    return ok(doc, "added version")
  }

  function isError(res) {
    return res && res[0]._id === '.error.'
  }

  function mergeVersions(newdoc, doc) {
    if (!newdoc.versions)
      return

    // If we are passing in the _rev, then that means that the client has
    // fetched the current doc, and explicitly chosen to remove stuff
    // If they aren't passing in a matching _rev, then just merge in
    // new stuff, don't allow clobbering, and ignore missing versions.
    var revMatch = newdoc._rev === doc._rev

    if (!doc.versions) doc.versions = {}
    for (var v in newdoc.versions) {
      var nv = newdoc.versions[v]
      var ov = doc.versions[v]

      if (ov && !ov.directories &&
          JSON.stringify(nv.directories) === '{}') {
        delete nv.directories
      }

      if (!ov) {
        var vc = semver.clean(v, true)
        if (!vc || v !== vc)
          return error('Invalid version: ' + v)
        var res = addNewVersion(v, newdoc.versions[v])
        if (isError(res))
          return res
      } else if (nv.deprecated) {
        ov.deprecated = nv.deprecated
      } else if (!deepEquals(nv, ov)) {
        d('old=%j', ov)
        d('new=%j', nv)
        // Trying to change an existing version!  Shenanigans!
        // XXX: we COULD just skip this version, and pretend
        // it worked, without actually updating.  The vdu would
        // catch it anyway.  Problem there is that then the user
        // doesn't see their stuff update, and wonders why.
        return error('Document Update Conflict: ' +
                     'cannot modify pre-existing version: ' + v + '\n' +
                     'old=' + JSON.stringify(ov) + '\n' +
                     'new=' + JSON.stringify(nv))
      }
    }

    if (revMatch) {
      for (var v in doc.versions) {
        if (!newdoc.versions[v])
          delete doc.versions[v]
      }
    }
  }

  function mergeUsers(newdoc, doc) {
    // Note: it IS actually legal to just PUT {_id,users:{..}}
    // since it'll just merge it in.
    if (!newdoc.users)
      return

    if (!doc.users) doc.users = {}
    if (newdoc.users[req.userCtx.name])
      doc.users[req.userCtx.name] = newdoc.users[req.userCtx.name]
    else
      delete doc.users[req.userCtx.name]
  }

  function mergeAttachments(newdoc, doc) {
    if (!newdoc._attachments)
      return
    if (!doc._attachments) doc._attachments = {}
    var inline = false
    for(var k in newdoc._attachments) {
      if(newdoc._attachments[k].data) {
        doc._attachments[k] = newdoc._attachments[k]
        inline = true
      }
    }
  }

  function updateDoc(newdoc, doc) {
    if (doc.time && doc.time.unpublished) {
      d("previously unpublished", doc.time.unpublished)
      newdoc._rev = doc._rev
      delete doc.time.unpublished
    }

    for (var i in newdoc) {
      if (typeof newdoc[i] === "string") {
        doc[i] = newdoc[i]
      }
    }

    // Only allow maintainer update if the rev matches
    if (newdoc.maintainers && newdoc._rev === doc._rev) {
      d("set doc.maintainers to newdoc.maintainers", newdoc.maintainers)
      doc.maintainers = newdoc.maintainers
    }

    if (newdoc["dist-tags"])
      doc["dist-tags"] = newdoc["dist-tags"]

    var res = mergeVersions(newdoc, doc)
    if (isError(res))
      return res

    var res = mergeUsers(newdoc, doc)
    if (isError(res))
      return res

    var res = mergeAttachments(newdoc, doc)
    if (isError(res))
      return res

    return ok(doc, "updated package")
  }
}
