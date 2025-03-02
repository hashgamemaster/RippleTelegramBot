import crypto from 'crypto'

async function dbAll(db, sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, items) => {
      if (err) {
        console.log(sql)
        console.log(err)
        reject(err)
      } else {
        resolve(items)
      }
    })
  })
}

async function dbGet(db, sql) {
  return new Promise((resolve, reject) => {
    db.get(sql, (err, item) => {
      if (err) {
        console.log(sql)
        console.log(err)
        reject(err)
      } else {
        resolve(item)
      }
    })
  })
}

async function dbRun(db, sql) {
  return new Promise((resolve, reject) => {
    db.run(sql, err => {
      if (err) {
        console.log(sql)
        console.log(err)
        reject(err)
      } else {
        resolve(true)
      }
    })
  })
}

function SHA512(str) {
  let hash = crypto.createHash("sha512")
  hash.update(str)
  return hash.digest('hex').toUpperCase()
}

export {
  dbGet,
  dbAll,
  dbRun,
  SHA512
}