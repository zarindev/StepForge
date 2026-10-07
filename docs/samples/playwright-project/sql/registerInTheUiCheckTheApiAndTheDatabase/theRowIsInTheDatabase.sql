-- Register in the UI, check the API and the database: The row is in the database
-- connection: clinic (sqlite)
SELECT full_name, phone FROM patients WHERE code = ?
