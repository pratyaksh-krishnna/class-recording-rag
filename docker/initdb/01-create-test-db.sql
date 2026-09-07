-- Runs once, on first initialisation of the data volume.
-- Integration tests target this database so they can truncate freely
-- without touching development data.
CREATE DATABASE rag_test;
