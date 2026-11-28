// Education product income is recognized only by completed rebate reconciliation.
const { policyIncomeSql } = require('./productIncomeSql');
function educationProductEntrySql() { return `${policyIncomeSql()} WHERE e.ENTRY_TYPE = 'education'`; }
module.exports = { educationProductEntrySql };
