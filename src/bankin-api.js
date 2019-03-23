const { requestFactory, errors, log } = require('cozy-konnector-libs');

const accountTypeMapping = require('./account-type-mapping');
const operationCategoryMapping = require('./operation-category-mapping');

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

module.exports = class BankinApi {
  constructor({ clientId, clientSecret, email, password }, { bankinDeviceId }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.email = email;
    this.password = password;
    this.bankinDeviceId = bankinDeviceId;
    this.baseUrl = 'https://sync.bankin.com';
    this.bankinVersion = '2018-06-15';
    this.accessToken = '';
    this.banks = [];
  }

  async generateDeviceId() {
    const url = `${this.baseUrl}/v2/devices`;
    const queryString = {
      client_id: this.clientId,
      client_secret: this.clientSecret
    };
    const requestPayload = {
      os: 'web',
      version: '1.0.0',
      width: 1920,
      height: 1080,
      model: 'web',
      has_fingerprint: false
    };

    const options = {
      url,
      body: requestPayload,
      json: true,
      qs: queryString,
      method: 'POST',
      headers: {
        'bankin-version': this.bankinVersion
      }
    };

    return new Promise(async resolve => {
      try {
        const response = await request(options);

        this.bankinDeviceId = response.udid;
        resolve(this.bankinDeviceId);
      } catch (error) {
        log('error', error);
        throw new Error(errors.VENDOR_DOWN);
      }
    });
  }

  async init() {
    if (!this.bankinDeviceId) {
      log('info', 'Generating device id ...');
      await this.generateDeviceId();
      log('info', 'Successfully generated device id');
    }

    log('info', 'Authenticating ...');
    await this.authenticate();
    log('info', 'Successfully logged in');

    log('info', 'Fetching banks');
    await this.fetchBanks();
    log('info', `Found #${Object.keys(this.banks).length} banks`);
  }

  authenticate() {
    const url = `${this.baseUrl}/v2/authenticate`;
    const qs = {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      email: this.email,
      password: this.password
    };

    const options = {
      url,
      qs,
      method: 'POST',
      headers: {
        'bankin-version': this.bankinVersion,
        'bankin-device': this.bankinDeviceId
      }
    };

    return new Promise(async resolve => {
      try {
        const tokens = await request(options);

        this.accessToken = tokens.access_token;
        resolve(tokens);
      } catch (error) {
        throw new Error(errors.LOGIN_FAILED);
      }
    });
  }

  async fetchAllOperations() {
    await this.init();
    log('info', 'Fetching the list of accounts');
    const accounts = await this.fetchAccounts();
    log('info', `Found #${accounts.length} accounts`);

    const allOperations = await this.fetchAccountsOperations(accounts);

    return { accounts, allOperations };
  }

  async fetchAccountsOperations(accounts) {
    let allOperations = [];

    log('info', 'Fetching operations');
    for (let account of accounts) {
      log(
        'info',
        `Fetching operations of account ${account.vendorId} - ${account.label}`
      );
      let operations = await this.fetchOperations(account);
      log('info', `Found #${operations.length} operations`);

      allOperations = [...allOperations, ...operations];
    }
    log('info', `Found #${allOperations.length} operations before filtering`);
    allOperations = this.filterOperations(accounts, allOperations);
    log('info', `Found #${allOperations.length} operations after filtering`);

    return allOperations;
  }

  filterOperations(accounts, operations) {
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
  }

  fetchBanks() {
    const url = `${this.baseUrl}/v2/banks`;
    const qs = {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      limit: 200
    };

    const options = {
      url,
      qs,
      method: 'GET',
      headers: {
        'bankin-version': this.bankinVersion
      }
    };

    return new Promise(async resolve => {
      try {
        const response = await request(options);

        this.banks = this.formatBanks(response.resources);
        resolve(this.banks);
      } catch (error) {
        throw new Error(errors.VENDOR_DOWN);
      }
    });
  }

  formatBanks(countries) {
    let banks = {};

    countries.forEach(country => {
      country.parent_banks.forEach(parentBank => {
        parentBank.banks.forEach(bank => {
          banks[bank.id] = bank;
        });
      });
    });

    return banks;
  }

  fetchAccounts() {
    const url = `${this.baseUrl}/v2/accounts`;
    const qs = {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      limit: 200
    };

    const options = {
      url,
      qs,
      method: 'GET',
      headers: {
        'bankin-version': this.bankinVersion,
        authorization: `Bearer ${this.accessToken}`
      }
    };

    return new Promise(async resolve => {
      try {
        const response = await request(options);

        resolve(this.formatAccounts(response.resources));
      } catch (error) {
        throw new Error(errors.VENDOR_DOWN);
      }
    });
  }

  formatAccounts(accounts) {
    return accounts.map(account => {
      let bank = 'none';

      if (account.bank.id in this.banks) {
        bank = this.banks[account.bank.id].name;
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
  }

  async fetchOperations(account) {
    const url = `${this.baseUrl}/v2/accounts/${account.vendorId}/transactions`;
    const qs = {
      client_id: this.clientId,
      client_secret: this.clientSecret,
      limit: 200
    };

    const options = {
      url,
      qs,
      method: 'GET',
      headers: {
        'bankin-version': this.bankinVersion,
        authorization: `Bearer ${this.accessToken}`
      }
    };
    let operations = [];
    let hasNext = false;

    do {
      const response = await request(options);

      operations = [
        ...operations,
        ...this.formatOperations(response.resources)
      ];
      hasNext = false;

      if (response.pagination.next_uri) {
        hasNext = true;
        options.url = `${this.baseUrl}${response.pagination.next_uri}`;
      }
    } while (hasNext);

    return operations;
  }

  formatOperations(operations) {
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
  }
};
