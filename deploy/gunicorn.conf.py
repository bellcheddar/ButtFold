"""gunicorn for ButtFold. Installed to /opt/buttfold/deploy/gunicorn.conf.py.

Two workers, not four. The droplet has 2 shared vCPUs and 3.9 GB split between six apps
now, and ButtFold's web layer does almost nothing: it serves a template, a few JSON files
and a queue's status. The work is the C binary the queue worker runs at nice 19, which is a
different process with a different budget.
"""

bind = "127.0.0.1:8007"
workers = 2
# Threads rather than more workers: every request is either a file read or a SQLite query,
# so they are IO-bound and a thread is far cheaper than a fork.
threads = 4
worker_class = "gthread"
timeout = 60
graceful_timeout = 30
keepalive = 5

accesslog = "-"
errorlog = "-"
# The client's real address, which the queue's per-IP cap depends on. Behind nginx every
# remote_addr is 127.0.0.1, so without the forwarded header the cap becomes a global cap of
# one: a queue that looks like it works and only ever serves one person.
forwarded_allow_ips = "127.0.0.1"
access_log_format = '%({x-forwarded-for}i)s %(t)s "%(r)s" %(s)s %(b)s %(D)sus'
