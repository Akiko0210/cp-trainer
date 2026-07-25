"""Postgres connection helper for the worker."""

import os

import psycopg
from psycopg.rows import dict_row

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://cp:cp@localhost:5488/cp_trainer"
)


def connect() -> psycopg.Connection:
    """One connection per job run; short-lived, autocommit off (explicit commits)."""
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)
