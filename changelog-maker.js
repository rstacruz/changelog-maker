#!/usr/bin/env node

const gitcmd        = 'git log --pretty=full --since="{{sincecmd}}" --until="{{untilcmd}}"'
    , commitdatecmd = '$(git show -s --format=%ad `{{refcmd}}`)'
    , untilcmd      = ''
    , refcmd        = 'git rev-list --max-count=1 {{ref}}'
    , defaultRef    = '--tags'


const spawn    = require('child_process').spawn
    , bl       = require('bl')
    , split2   = require('split2')
    , list     = require('list-stream')
    , after    = require('after')
    , ghauth   = require('ghauth')
    , ghissues = require('ghissues')
    , chalk    = require('chalk')
    , argv     = require('minimist')(process.argv.slice(2))

    , commitStream = require('./commit-stream')

    , ghUser        = argv._[0] || 'iojs'
    , ghProject     = argv._[1] || 'io.js'
    , authOptions   = {
          configName : 'changelog-maker'
        , scopes     : []
      }


function replace (s, m) {
  Object.keys(m).forEach(function (k) {
    s = s.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), m[k])
  })
  return s
}


function organiseCommits (list) {
  if (argv['start-ref'])
    return list

  // filter commits to those _before_ 'working on ...'
  var started = false
  return list.filter(function (commit) {
    if (started)
      return false

    if ((/working on v?[\d\.]+/i).test(commit.summary))
      started = true
    else if ((/^v?[\d\.]+$/).test(commit.summary))
      started = true

    return !started
  })
}


function commitTags (list, callback) {
  var sublist = list.filter(function (commit) {
    return typeof commit.ghIssue == 'number' && commit.ghUser && commit.ghProject
  })

  if (!sublist.length)
    return setImmediate(callback)

  ghauth(authOptions, function (err, authData) {
    if (err)
      return callback(err)

    var done = after(sublist.length, callback)

    sublist.forEach(function (commit) {
      function onFetch (err, issue) {
        if (err) {
          console.error(`Error fetching issue #${commit.ghIssue}: ${err.message}`)
          return done()
        }

        if (issue.labels)
          commit.labels = issue.labels.map(function (label) { return label.name })
        done()
      }

      ghissues.get(authData, commit.ghUser, commit.ghProject, commit.ghIssue, onFetch)
    })
  })
}


function commitToGroup (commit) {
  return (/^[\w,]+:/.test(commit.summary) && commit.summary.split(':')[0]) || null
}


function cleanMarkdown (txt) {
  // just escape '[' & ']'
  return txt.replace(/([\[\]])/g, '\\$1')
}


function commitToOutput (commit) {
  var semver     = commit.labels && commit.labels.filter(function (l) { return l.indexOf('semver') > -1 }) || false
    , group      = commitToGroup(commit) || ''
    , summaryOut = !group ? commit.summary : commit.summary.substr(group.length + 2)
    , shaOut     = `[\`${commit.sha.substr(0,10)}\`](https://github.com/${ghUser}/${ghProject}/commit/${commit.sha.substr(0,10)})`
    , labelOut   = (semver.length ? '(' + semver.join(', ').toUpperCase() + ') ' : '') + group
    , prUrlMatch = commit.prUrl && commit.prUrl.match(/^https?:\/\/.+\/([^\/]+\/[^\/]+)\/\w+\/\d+$/i)
    , out

  if (argv.simple) { 
    if (labelOut.length)
      summaryOut = `${labelOut}: ${summaryOut}`
    out = `* [${commit.sha.substr(0,10)}] - ${summaryOut} (${commit.author.name})`

    if (prUrlMatch)
      out += ` ${prUrlMatch[1] != ghUser + '/' + ghProject ? prUrlMatch[1] : ''}#${commit.ghIssue || commit.prUrl}`
  } else {
    if (labelOut.length)
      summaryOut = `**${labelOut}**: ${summaryOut}`
    out = `* [${shaOut}] - ${cleanMarkdown(summaryOut)} (${commit.author.name})`

    if (prUrlMatch)
      out += ` [${prUrlMatch[1] != ghUser + '/' + ghProject ? prUrlMatch[1] : ''}#${commit.ghIssue || commit.prUrl}](${commit.prUrl})`
  }

  return semver.length
      ? chalk.green(chalk.bold(out))
      : group == 'doc' ? chalk.grey(out) : out
}


function groupCommits (list) {
  var groups = list.reduce(function (groups, commit) {
    var group = commitToGroup(commit) || '*'
    if (!groups[group])
      groups[group] = []
    groups[group].push(commit)
    return groups
  }, {})

  return Object.keys(groups).sort().reduce(function (p, group) {
    return p.concat(groups[group])
  }, [])
}


function printCommits (list) {
  var out = `${list.join('\n')} \n`

  if (!process.stdout.isTTY)
    out = chalk.stripColor(out)

  process.stdout.write(out)
}


function onCommitList (err, list) {
  if (err)
    throw err

  list = organiseCommits(list)

  commitTags(list, function (err) {
    if (err)
      throw err

    if (argv.group)
      list = groupCommits(list)

    list = list.map(commitToOutput)

    printCommits(list)
  })
}


var _startrefcmd = replace(refcmd, { ref: argv['start-ref'] || defaultRef })
  , _endrefcmd   = argv['end-ref'] && replace(refcmd, { ref: argv['end-ref'] })
  , _sincecmd    = replace(commitdatecmd, { refcmd: _startrefcmd })
  , _untilcmd    = argv['end-ref'] ? replace(commitdatecmd, { refcmd: _endrefcmd }) : untilcmd
  , _gitcmd      = replace(gitcmd, { sincecmd: _sincecmd, untilcmd: _untilcmd })
  , child        = spawn('bash', [ '-c', _gitcmd ])

child.stdout.pipe(split2()).pipe(commitStream(ghUser, ghProject)).pipe(list.obj(onCommitList))

child.stderr.pipe(bl(function (err, _data) {
  if (err)
    throw err

  if (_data.length)
    process.stderr.write(_data)
}))

child.on('close', function (code) {
  if (code)
    throw new Error(`git command [${gitcmd}] exited with code ${code}`)
})
