-- Deleting a patient removes their appointments: No appointments are left for the deleted patient
-- connection: clinic (sqlite)
SELECT COUNT(*) AS n FROM appointments WHERE patient_id = ?
