const {
  BaseKonnector,
  requestFactory,
  errors,
  updateOrCreate,
  log,
  cozyClient
} = require('cozy-konnector-libs');
const doctypes = require('cozy-doctypes');
const moment = require('moment');

const accountTypeMapping = require('./account-type-mapping');
const operationCategoryMapping = require('./operation-category-mapping');

const { BankAccount, BankTransaction, BankingReconciliator } = doctypes;
const request = requestFactory({
  // the debug mode shows all the details about http request and responses. Very useful for
  // debugging but very verbose. That is why it is commented out by default
  debug: false,
  // activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: false,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: true,
  // this allows request-promise to keep cookies between requests
  jar: true
});
doctypes.registerClient(cozyClient);

const reconciliator = new BankingReconciliator({
  BankAccount,
  BankTransaction
});

const baseUrl = 'https://sync.bankin.com';
const bankinVersion = '2018-06-15';
let accesToken;
let banks;

module.exports = new BaseKonnector(start);

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...');
  const tokens = await authenticate(fields);
  accesToken = tokens.access_token;
  log('info', 'Successfully logged in');

  log('info', 'Fetching banks');
  banks = await fetchBanks(fields);
  log('info', `Found #${Object.keys(banks).length} banks`);

  log('info', 'Fetching the list of accounts');
  const accounts = await fetchAccounts(fields);
  log('info', `Found #${accounts.length} accounts`);

  let allOperations = [];

  log('info', 'Fetching operations');
  for (let account of accounts) {
    log(
      'info',
      `Fetching operations of account ${account.vendorId} - ${account.label}`
    );
    let operations = await fetchOperations(fields, account);
    log('info', `Found #${operations.length} operations`);

    allOperations = [...allOperations, ...operations];
  }
  log('info', `Found #${allOperations.length} operations before filtering`);
  allOperations = filterOperations(accounts, allOperations);
  log('info', `Found #${allOperations.length} operations after filtering`);

  const { accounts: savedAccounts } = await reconciliator.save(
    accounts,
    allOperations
  );
  const balances = await fetchBalances(savedAccounts);
  await saveBalances(balances);
}

const filterOperations = (accounts, operations) => {
  const vendorsIds = accounts.map(account => account.vendorId);
  const operationsIds = [];

  return operations
    .filter(operation => vendorsIds.indexOf(operation.vendorAccountId) !== -1)
    .filter(operation => {
      if (operationsIds.indexOf(operation.vendorId) === -1) {
        operationsIds.push(operation.vendorId);

        return true;
      }

      return false;
    });
};

const authenticate = ({
  client_id,
  client_secret,
  email,
  password,
  bankinDevice
}) => {
  const url = `${baseUrl}/v2/authenticate`;
  const qs = {
    client_id,
    client_secret,
    email,
    password
  };

  const options = {
    url,
    qs,
    method: 'POST',
    headers: {
      'bankin-version': bankinVersion,
      'bankin-device': bankinDevice
    }
  };

  return new Promise(async resolve => {
    try {
      const response = await request(options);

      resolve(response);
    } catch (error) {
      throw new Error(errors.LOGIN_FAILED);
    }
  });
};

const fetchBanks = ({ client_id, client_secret }) => {
  const url = `${baseUrl}/v2/banks`;
  const qs = {
    client_id,
    client_secret,
    limit: 200
  };

  const options = {
    url,
    qs,
    method: 'GET',
    headers: {
      'bankin-version': bankinVersion
    }
  };

  return new Promise(async resolve => {
    try {
      const response = await request(options);

      resolve(formatBanks(response.resources));
    } catch (error) {
      throw new Error(errors.VENDOR_DOWN);
    }
  });
};

const formatBanks = countries => {
  let banks = {};

  countries.forEach(country => {
    country.parent_banks.forEach(parentBank => {
      parentBank.banks.forEach(bank => {
        banks[bank.id] = bank;
      });
    });
  });

  return banks;
};

const fetchAccounts = ({ client_id, client_secret }) => {
  const url = `${baseUrl}/v2/accounts`;
  const qs = {
    client_id,
    client_secret,
    limit: 200
  };

  const options = {
    url,
    qs,
    method: 'GET',
    headers: {
      'bankin-version': bankinVersion,
      authorization: `Bearer ${accesToken}`
    }
  };

  return new Promise(async resolve => {
    try {
      const response = await request(options);

      resolve(formatAccounts(response.resources));
    } catch (error) {
      throw new Error(errors.VENDOR_DOWN);
    }
  });
};

const formatAccounts = accounts => {
  return accounts.map(account => {
    let bank = 'none';

    if (account.bank.id in banks) {
      bank = banks[account.bank.id].name;
    }

    return {
      label: account.name,
      institutionLabel: bank,
      balance: account.balance,
      type:
        account.type in accountTypeMapping
          ? accountTypeMapping[account.type]
          : 'none',
      number: account.id,
      vendorId: account.id
    };
  });
};

const fetchOperations = async ({ client_id, client_secret }, account) => {
  const url = `${baseUrl}/v2/accounts/${account.vendorId}/transactions`;
  const qs = {
    client_id,
    client_secret,
    limit: 200
  };

  const options = {
    url,
    qs,
    method: 'GET',
    headers: {
      'bankin-version': bankinVersion,
      authorization: `Bearer ${accesToken}`
    }
  };
  let operations = [];
  let hasNext = false;

  do {
    const response = await request(options);

    operations = [...operations, ...formatOperations(response.resources)];
    hasNext = false;

    if (response.pagination.next_uri) {
      hasNext = true;
      options.url = `${baseUrl}${response.pagination.next_uri}`;
    }
  } while (hasNext);

  return operations;
};

const formatOperations = operations => {
  return operations.map(operation => {
    const category =
      operation.category.id in operationCategoryMapping
        ? operationCategoryMapping[operation.category.id].cozyCategoryId
        : 0;

    return {
      date: new Date(operation.date),
      label: operation.description,
      originalLabel: operation.raw_description,
      type: 'none',
      automaticCategoryId: category,
      dateImport: new Date(),
      dateOperation: new Date(operation.date),
      currency: operation.currency_code,
      vendorAccountId: operation.account.id,
      vendorId: operation.id,
      amount: operation.amount
    };
  });
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
