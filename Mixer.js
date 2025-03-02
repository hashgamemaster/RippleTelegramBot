import xrpl, { dropsToXrp, convertHexToString, xrpToDrops } from 'xrpl'
import sqlite3 from 'sqlite3'
import TelegramBot from 'node-telegram-bot-api'
import { dbGet, dbAll, dbRun, SHA512 } from './Util.js'

const TxType = {
  Payment: 'Payment'
}

const TxResult = {
  Success: 'tesSUCCESS'
}

const MinFee = 0.01
const MaxFeeRate = 1

const telegram_bot_token = 'your_telegram_bot_token'
const bot = new TelegramBot(telegram_bot_token, { polling: true })
const ServiceSeed = 'your_ripple_account_seed'
const ServiceWallet = xrpl.Wallet.fromSeed(ServiceSeed)
const ServiceAccount = ServiceWallet.classicAddress
console.log(ServiceAccount)
// const client = new xrpl.Client('wss://s1.ripple.com')
const client = new xrpl.Client('wss://s.altnet.rippletest.net:51233/')

const regex_send_head = /^\/send.*$/
const regex_send_full = /^\/send\s+(r[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{32,33})\s+(\d+(\.\d+)?)\s*$/
const regex_xrp_amount = /^\d+(\.\d{1,6})?$/

async function initDB(db) {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS USERS(
        tg_id             INTEGER PRIMARY KEY,
        is_bot            BOOLEAN,
        first_name        TEXT,
        last_name         TEXT,
        username          TEXT,
        language_code     TEXT,
        destination_tag   INTEGER,
        refferal          INTEGER DEFAULT 0,
        balance           INTEGER,
        balance_available INTEGER,
        created_at        INTEGER,
        updated_at        INTEGER,
        online_at         INTEGER
      )`,
      err => {
        if (err) {
          console.log(err)
        }
      }
    )

    db.run(`CREATE TABLE IF NOT EXISTS TXS(
        ledger_index     INTEGER,
        ledger_hash      VARCHAR(64),
        tx_index         INTEGER,
        tx_type          TEXT,
        tx_result        TEXT,
        tx_sequence      INTEGER,
        tx_hash          VARCHAR(64) PRIMARY KEY,
        sour             VARCHAR(35),
        dest             VARCHAR(35),
        delivered_amount INTEGER,
        fee              INTEGER,
        source_tag       INTEGER DEFAULT 0,
        destination_tag  INTEGER DEFAULT 0,
        close_time_iso   TEXT,
        memos            TEXT DEFAULT '',
        json             TEXT,
        is_calc          BOOLEAN DEFAULT false
      )`,
      err => {
        if (err) {
          console.log(err)
        }
      }
    )

    db.run(`CREATE TABLE IF NOT EXISTS SENDS(
        action_hash    VARCHAR(64) PRIMARY KEY,
        tg_id          INTEGER,
        tx_hash        VARCHAR(64),
        dest           VARCHAR(35),
        amount         INTEGER,
        created_at     INTEGER
      )`,
      err => {
        if (err) {
          console.log(err)
        }
      }
    )
  })
}

function genDestinationTag(tg_id) {
  let id_hash = SHA512(`${tg_id}`)
  id_hash = SHA512(`${tg_id}@${id_hash}`)
  id_hash = id_hash.substring(0, 8)
  let destination_tag = parseInt(id_hash, 16)
  return destination_tag
}

function URLforTx(tx_hash) {
  return `https://testnet.xrpl.org/transactions/${tx_hash}`
}

async function updateUserOnlineTimestamp(db, tg_user) {
  let timestamp = Date.now()
  let sql = `SELECT * FROM USERS WHERE tg_id = ${tg_user.id} LIMIT 1`
  let user = await dbGet(db, sql)
  if (user == null) {
    let destination_tag = genDestinationTag(tg_user.id)
    sql = `INSERT INTO USERS (tg_id, is_bot, first_name, last_name, username, language_code, destination_tag, balance, balance_available, created_at, updated_at, online_at)
      VALUES (${tg_user.id}, ${tg_user.is_bot}, '${tg_user.first_name}',' ${tg_user.last_name}', '${tg_user.username}', '${tg_user.language_code}', ${destination_tag}, 0, 0, ${timestamp}, ${timestamp}, ${timestamp})`
    await dbRun(db, sql)
    return user
  } else {
    sql = `UPDATE USERS SET online_at = ${timestamp} WHERE tg_id = ${tg_user.id}`
    await dbRun(db, sql)
    return user
  }
}

async function fetchServiceAccountTx(client, db) {
  try {
    let page_size = 100
    let done = false
    let marker = undefined
    while (!done) {
      const response = await client.request({
        command: 'account_tx',
        account: ServiceAccount,
        limit: page_size,
        marker: marker
      })
      let txs = response.result.transactions
      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i]
        let sql = `SELECT * FROM TXS WHERE tx_hash == '${tx.hash}' LIMIT 1`
        let item = await dbGet(db, sql)
        if (item != null) {
          done = true
          return
        } else if (tx.validated == true) {
          let tmp_memos = []
          if (tx.tx_json.Memos) {
            let memo_length = tx.tx_json.Memos.length
            for (let i = 0; i < memo_length; i++) {
              const memo = tx.tx_json.Memos[i].Memo
              let tmp_memo = {}
              for (const key in memo) {
                tmp_memo[key] = convertHexToString(memo[key])
              }
              tmp_memos.push(tmp_memo)
            }
          }

          if (tx.tx_json.TransactionType == TxType.Payment && tx.meta.TransactionResult == TxResult.Success) {
            // !!! validated+payment+success
            let amount = parseInt(tx.meta.delivered_amount)
            let fee = parseInt(tx.tx_json.Fee)
            let source_tag = 0
            let destination_tag = 0
            if (tx.tx_json.SourceTag) {
              source_tag = tx.tx_json.SourceTag
            }
            if (tx.tx_json.DestinationTag) {
              destination_tag = tx.tx_json.DestinationTag
            }
            sql = `INSERT INTO TXS (ledger_index, ledger_hash, tx_index, tx_type, tx_result, tx_sequence, tx_hash, sour, dest, delivered_amount, fee, source_tag, destination_tag, close_time_iso, json, memos, is_calc)
              VALUES (${tx.ledger_index}, '${tx.ledger_hash}', ${tx.meta.TransactionIndex} , '${tx.tx_json.TransactionType}', '${tx.meta.TransactionResult}', ${tx.tx_json.Sequence}, '${tx.hash}', '${tx.tx_json.Account}', '${tx.tx_json.Destination}', ${amount}, ${fee}, ${source_tag}, ${destination_tag}, '${tx.close_time_iso}', '${JSON.stringify(tx)}', '${JSON.stringify(tmp_memos)}', false)`
            await dbRun(db, sql)
          } else {
            sql = `INSERT INTO TXS (ledger_index, ledger_hash, tx_index, tx_type, tx_result, tx_sequence, tx_hash, fee, close_time_iso, json, memos, is_calc)
              VALUES (${tx.ledger_index}, '${tx.ledger_hash}', ${tx.meta.TransactionIndex} , '${tx.tx_json.TransactionType}', '${tx.meta.TransactionResult}', ${tx.tx_json.Sequence}, '${tx.hash}', '${tx.tx_json.Fee}', '${tx.close_time_iso}', '${JSON.stringify(tx)}', '${JSON.stringify(tmp_memos)}', false)`
            await dbRun(db, sql)
          }
        }
      }
      if (response.result.marker) {
        marker = response.result.marker
      } else {
        done = true
      }
    }
  } catch (error) {
    console.error(error)
  }
}

function calc_balance_available(balance) {
  if (balance <= xrpToDrops(MinFee / (MaxFeeRate / 100))) {
    return balance - xrpToDrops(MinFee)
  } else {
    return Math.floor(balance * (1 - MaxFeeRate / 100))
  }
}

function calc_fee(amount) {
  if (amount <= xrpToDrops(MinFee / (MaxFeeRate / 100))) {
    return xrpToDrops(MinFee)
  } else {
    return Math.floor(amount * (MaxFeeRate / 100))
  }
}

async function updateUserBalance(db, user) {
  user.balance_available = calc_balance_available(user.balance)
  let sql = `UPDATE USERS SET balance = ${user.balance}, balance_available = ${user.balance_available} WHERE tg_id = ${user.tg_id}`
  await dbRun(db, sql)
  return user
}

async function PayXRP(client, wallet, sour, dest, amount) {
  try {
    let transaction = await client.autofill({
      TransactionType: TxType.Payment,
      Account: sour,
      Destination: dest,
      Fee: '12',
      Amount: amount
    })
    const signed = wallet.sign(transaction)
    const tx_blob = signed.tx_blob

    const submitRequest = {
      api_version: 2,
      command: 'submit',
      tx_blob: tx_blob,
      ledger_index: 'current'
    }
    const response = await client.request(submitRequest)
    // console.log(response)
    return response
  } catch (error) {
    console.error('send XRP failure:', error)
  }
}

async function calc_receive(db, user, destination_tag) {
  let sql = `SELECT * FROM TXS WHERE is_calc = false AND destination_tag = ${destination_tag} AND dest = '${ServiceAccount}' AND tx_type = '${TxType.Payment}' AND tx_result = '${TxResult.Success}'`
  let get_txs = await dbAll(db, sql)

  let receive_amount = 0
  for (let i = 0; i < get_txs.length; i++) {
    const tx = get_txs[i]
    receive_amount = receive_amount + tx.delivered_amount
  }

  if (receive_amount != 0) {
    sql = `UPDATE TXS SET is_calc = true WHERE destination_tag = ${destination_tag}`
    await dbRun(db, sql)

    user.balance = user.balance + receive_amount
    user = await updateUserBalance(db, user)
  }
  return user
}

async function main() {
  let db_path = `./Mixer.db`
  let DB = new sqlite3.Database(db_path)
  await initDB(DB)

  await client.connect()
  let txJob = setInterval(() => {
    fetchServiceAccountTx(client, DB)
  }, 10 * 1000)


  bot.on('message', async (msg) => {
    const chat_id = msg.chat.id
    const chat_msg = msg.text
    const destination_tag = genDestinationTag(msg.from.id)
    let user = await updateUserOnlineTimestamp(DB, msg.from)
    let resq = ''
    let timestamp = Date.now()

    if (chat_msg == '/help' || chat_msg == '/start') {
      resq = `
      Hello @${msg.from.username},
  your DestinationTag is ${destination_tag}.
  the ServiceAccount is ${ServiceAccount}.
  
  # Bot Function:
  1. Confusing transaction between source and destination with ServiceAccount in middle.
  2. Anonymous receive XRP from any account.
  
  # Theory: 
  1. Every telegram user get a unique DestinationTag
  2. Receive: 
  - Send XRP to the ServiceAccount with your DestinationTag.
  - All the XRP ServiceAccount received with your DestinationTag will be your balance(/balance), no matter from which source account.
  3. Send:
  You can tell ServiceAccount to send XRP to any account.
  
  # Service & Price:
  1. Receive for free.
  2. Send for ${MinFee} XRP(minimum) or ${MaxFeeRate}%(maximum) per transaction.

  # Command example
  1. /help: for help info
  2. /balance: query current balance
  3. /histroy_receive or /hr: query receive transaction histroy
  4. /histroy_send or /hs: query send transaction histroy
  5. /delete_histroy_send or /dhs: delete send transaction histroy
  6. /receive: show your DestinationTag and the ServiceAccount
  7. /send r...your_destination_account... 5.8
  send 5.8XRP to r...your_destination_account...
  `
    } else if (chat_msg == '/balance') {
      user = await calc_receive(DB, user, destination_tag)
      resq = `Balance: ${dropsToXrp(user.balance)} XRP, BalanceAvailable ${dropsToXrp(user.balance_available)} XRP`
    } else if (chat_msg == '/histroy_receive' || chat_msg == '/hr') {
      let sql = `SELECT * FROM TXS WHERE destination_tag = ${destination_tag} AND dest = '${ServiceAccount}' AND tx_type = '${TxType.Payment}' AND tx_result = '${TxResult.Success}' ORDER BY ledger_index DESC, tx_index DESC`
      let txs = await dbAll(DB, sql)
      if (txs.length == 0) {
        resq = `no receive tx found...`
      } else {
        for (let i = 0; i < txs.length; i++) {
          const tx = txs[i]
          resq = resq + `receive ${dropsToXrp(tx.delivered_amount)} XRP from ${tx.sour}
@${tx.close_time_iso}
${URLforTx(tx.tx_hash)}
\n`
        }
      }
    } else if (chat_msg == '/histroy_send' || chat_msg == '/hs') {
      let sql = `SELECT * FROM SENDS WHERE tx_hash != '' ORDER BY created_at DESC`
      let txs = await dbAll(DB, sql)
      if (txs.length == 0) {
        resq = `no send record found...`
      } else {
        for (let i = 0; i < txs.length; i++) {
          const tx = txs[i]
          let timestamp = new Date(tx.created_at)
          timestamp = timestamp.toISOString()
          resq = resq + `send ${dropsToXrp(tx.amount)} XRP to ${tx.dest}
@${timestamp}
${URLforTx(tx.tx_hash)}
\n`
        }
      }
    } else if (chat_msg == '/delete_histroy_send' || chat_msg == '/dhs') {
      let sql = `DELETE FROM SENDS WHERE tx_hash != ''`
      await dbRun(DB, sql)
      resq = `all send tx histroy is deleted!`
    } else if (chat_msg == '/receive') {
      resq = `Your DestinationTag is ${destination_tag}.
The ServiceAccount is ${ServiceAccount}.
      
Send XRP from any account to the ServiceAccount with your DestinationTag.
      
You can use your ripple wallet, or with this open source web ripple wallet(https://github.com/hashgamemaster/RippleWebWallet)
      `
    } else {
      let match = chat_msg.match(regex_send_head)
      if (match) {
        match = chat_msg.match(regex_send_full)
        if (match) {
          let dest = match[1]
          let amount = match[2]
          if (regex_xrp_amount.test(amount)) {
            if (xrpl.isValidAddress(dest)) {
              amount = xrpToDrops(amount)
              let sql = `SELECT * FROM USERS WHERE tg_id = ${msg.from.id} LIMIT 1`
              let user = await dbGet(DB, sql)

              if (amount > user.balance_available) {
                resq = `Amount(${dropsToXrp(amount)} XRP) is larger than you available balance(${dropsToXrp(user.balance_available)} XRP)...`
              } else if (dest == ServiceAccount) {
                resq = `Are you Sure?
You are sending XRP to the ServiceAccount(${ServiceAccount})...`
              } else {
                let fee = calc_fee(amount)
                user.balance = user.balance - amount - fee
                user = await updateUserBalance(DB, user)
                let action_hash = SHA512(`${user.tg_id}${timestamp}${Math.random()}`).substring(0, 63)
                sql = `INSERT INTO SENDS (action_hash, tg_id, tx_hash, dest, amount, created_at)
                  VALUES ('${action_hash}', ${user.tg_id}, '', '${dest}', ${amount}, ${timestamp})`
                await dbRun(DB, sql)
                let response = await PayXRP(client, ServiceWallet, ServiceAccount, dest, amount)
                if (response.result.accepted == true && response.result.applied == true && response.result.engine_result == TxResult.Success) {
                  sql = `UPDATE SENDS SET tx_hash = '${response.result.tx_json.hash}' WHERE action_hash = '${action_hash}'`
                  await dbRun(DB, sql)
                  resq = `Send success, see detail at
${URLforTx(response.result.tx_json.hash)}`
                } else {
                  resq = `Send failure, please wait admin to handle the problem...`
                }
              }
            } else {
              resq = `Dest(${dest}) is not a valid account address...`
            }
          } else {
            resq = `Amount(${amount}) has too many(more than 6) decimal places...`
          }
        } else {
          resq = `
Please provide valid destination account address and valid amount of XRP.
      `
        }
      } else {
        resq = `invalid command..., please use /help for more info...`
      }
    }
    bot.sendMessage(chat_id, resq)
  })
}

main()