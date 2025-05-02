import { formatToDDMMYYYY } from './date.js';

function cleanAndJoinString(input) {
    return input
        .replace(/[\[\]"]/g, '')  // Remove brackets and double quotes
        .replace(/\\/g, '')       // Remove escape sequences (like \" )
        .trim();                  // Remove leading/trailing spaces
}

function toValidNumber(value, defaultValue = 0) {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "" && !isNaN(Number(value))) {
      return Number(value);
    }
    return defaultValue;
}

function extractDrugList(row) {
    return {
      ndcDrugCode: row?.ndcDrugCode || row?.Regulatory_Drug_Code || "ss",
      dispensedQuantity: toValidNumber(row?.["dispensedQuantity"] ?? row?.["Quantity"]),
      amount: toValidNumber(row?.["amount"] ?? row?.["Gross_Amount"]),
      daysOfSupply: toValidNumber(row?.["daysOfSupply"] ?? row?.["Duration"]),
    };
}

export function processWorksheet(data, prefix = 'POC') {
    const acc = new Map(); // Use Map for fast lookup
    const today = new Date();
    const currentDate = `${today.getDate()}${today.toLocaleString('default', { month: 'short' })}${today.getFullYear()}`;
    const splitField = (field) => 
        field ? cleanAndJoinString(String(field)).split(',').map(code => code.trim()).filter(code => code) : [];

    for (let i = 0; i < data.length; i++) {
        const curr = data[i];
        const transactionId = curr['Transaction_Id'];
        if (!transactionId) continue;
        const Primary_ICD_Code = splitField(curr.Primary_ICD_Code);
        const Secondary_ICD_Codes = splitField(curr.Secondary_ICD_Codes);
        if (acc.has(transactionId)) {
            // Update existing entry
            const existing = acc.get(transactionId);
            const existing_ICD = existing.icdCodes;
            const icdCodes = [...new Set([...existing_ICD, ...Primary_ICD_Code, ...Secondary_ICD_Codes])];
            const drug = extractDrugList(curr);
            existing.drugList = [ ...existing?.drugList, drug];
            existing.icdCodes = icdCodes;
        } else {
            // Create new entry
            acc.set(transactionId, {
                "requestId": `${prefix}_${currentDate}_${curr.Transaction_Id}`,
                "payerId": curr.Payer_Id || 402,
                "prescriberId": curr.Prescriber_Id ?? null,
                "memberId": `${prefix}_${currentDate}_${curr.Member_Id?.replace("mem-", "")}`,
                "memberWeight": curr.Weight ?? null,
                "pharmacyId": curr.Provider_Id ?? null,
                "memberGender": curr.Gender?.toUpperCase(),
                "dateOfService": formatToDDMMYYYY(curr.Treatment_Date),
                "dateOfBirth": formatToDDMMYYYY(curr.Date_Of_Birth),
                "icdCodes": [...new Set([...Primary_ICD_Code, ...Secondary_ICD_Codes])],
                "drugList": [extractDrugList(curr)]
            });
        }
    }
    return Array.from(acc.values()); // Convert Map back to array
} 