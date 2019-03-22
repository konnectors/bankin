const {
  BaseKonnector,
  updateOrCreate,
  log,
  cozyClient
} = require('cozy-konnector-libs');
const doctypes = require('cozy-doctypes');
const moment = require('moment');

const BankinApi = require('./bankin-api');

const { BankAccount, BankTransaction, BankingReconciliator } = doctypes;
doctypes.registerClient(cozyClient);

const reconciliator = new BankingReconciliator({
  BankAccount,
  BankTransaction
});

const defaultClientId = process.env.DEFAULT_CLIENT_ID;
const defaultClientSecret = process.env.DEFAULT_CLIENT_SECRET;

module.exports = new BaseKonnector(start);

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  fields = surchargeFields(fields);

  const bankinApi = new BankinApi(fields);
  await bankinApi.init();

  log('info', 'Fetching the list of accounts');
  const accounts = await bankinApi.fetchAccounts(fields);
  log('info', `Found #${accounts.length} accounts`);

  let allOperations = [];

  log('info', 'Fetching operations');
  for (let account of accounts) {
    log(
      'info',
      `Fetching operations of account ${account.vendorId} - ${account.label}`
    );
    let operations = await bankinApi.fetchOperations(account);
    log('info', `Found #${operations.length} operations`);

    allOperations = [...allOperations, ...operations];
  }
  log('info', `Found #${allOperations.length} operations before filtering`);
  allOperations = bankinApi.filterOperations(accounts, allOperations);
  log('info', `Found #${allOperations.length} operations after filtering`);

  const { accounts: savedAccounts } = await reconciliator.save(
    accounts,
    allOperations
  );
  const balances = await fetchBalances(savedAccounts);
  await saveBalances(balances);
}

const surchargeFields = fields => {
  if (!(typeof fields.clientId === 'string') || fields.clientId.length === 0) {
    fields.clientId = defaultClientId;
  }

  if (!(typeof fields.clientSecret === 'string') || fields.clientSecret.length === 0) {
    fields.clientSecret = defaultClientSecret;
  }

  return fields;
};

const fetchBalances = accounts => {
  const now = moment();
  const todayAsString = now.format('YYYY-MM-DD');
  const currentYear = now.year();

  return Promise.all(
    accounts.map(async account => {
      const history = await getBalanceHistory(currentYear, account._id);
      history.balances[todayAsString] = account.balance;

      return history;
    })
  );
};

const getBalanceHistory = async (year, accountId) => {
  const index = await cozyClient.data.defineIndex(
    'io.cozy.bank.balancehistories',
    ['year', 'relationships.account.data._id']
  );
  const options = {
    selector: { year, 'relationships.account.data._id': accountId },
    limit: 1
  };
  const [balance] = await cozyClient.data.query(index, options);

  if (balance) {
    log(
      'info',
      `Found a io.cozy.bank.balancehistories document for year ${year} and account ${accountId}`
    );
    return balance;
  }

  log(
    'info',
    `io.cozy.bank.balancehistories document not found for year ${year} and account ${accountId}, creating a new one`
  );
  return getEmptyBalanceHistory(year, accountId);
};

const getEmptyBalanceHistory = (year, accountId) => {
  return {
    year,
    balances: {},
    metadata: {
      version: 1
    },
    relationships: {
      account: {
        data: {
          _id: accountId,
          _type: 'io.cozy.bank.accounts'
        }
      }
    }
  };
};

const saveBalances = balances => {
  return updateOrCreate(balances, 'io.cozy.bank.balancehistories', ['_id']);
};
