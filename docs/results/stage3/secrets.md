# Secrets: two, not ten

## What the workflow actually reads

```
${{ secrets.AWS_ACCESS_KEY_ID }}
${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

Both appear once, in one step, and go in through the **environment** rather than
argv so they cannot show up in a process listing.

## What is generated on the runner instead

Eight values used to be manual copies. They are now created inside the same job
by `openssl rand`, masked with `::add-mask::`, written `0600` to
`$RUNNER_TEMP/trust/secrets.env`, and deleted with the runner:

| Value | How it is made |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -base64 36` |
| `REDIS_PASSWORD` | `openssl rand -base64 36` |
| `GRAFANA_ADMIN_PASSWORD` | `openssl rand -base64 36` |
| `JWT_SECRET` | `openssl rand -hex 32` (64 chars, over the 32 minimum) |
| `LOADTEST_PASSWORD` | `openssl rand -base64 36` |
| `EVIDENCE_TOKEN` | `openssl rand -hex 32` (64 chars, over the 32 minimum) |
| TLS certificate for `capacity-run.test` | self-signed on the runner, 1-day, SAN `DNS:capacity-run.test` |
| TLS key | generated with the certificate |

The matching trust - the CA, the certificate and the evidence token - stays on
the same runner for the life of the job, because that runner is the client that
must verify the certificate. Nothing is uploaded: the artifact step copies only
`*.txt`, `*.log`, `*.body`, `*.err` and the status snapshots, all of which are the
redacted forms. `trust/secrets.env` is never included.

## Why these two cannot be generated

The AWS key is the authority to create the instance. Generating it on the runner
would need something already authorized to mint one, which is the same secret by
another name. It is genuinely external.

## Setting them

1. Open <https://github.com/BhaveshSab/assetflow/settings/secrets/actions>
2. **New repository secret**
3. Name: `AWS_ACCESS_KEY_ID`, Value: the access key id from the `[capacity]`
   profile in `~/.aws/credentials`. Save.
4. **New repository secret**
5. Name: `AWS_SECRET_ACCESS_KEY`, Value: the matching secret key. Save.

To read them one at a time without printing both:

```
grep 'aws_access_key_id' ~/.aws/credentials
grep 'aws_secret_access_key' ~/.aws/credentials
```

Never paste either into a chat, a commit, an issue or an artifact.

## Honest limitation

These are long-lived IAM user keys. The previous recommendation was to rotate
them, and that still stands: rotating after the run costs nothing and removes a
key that has been visible in this conversation's history. Rotating now would
mean the value you paste is one nobody has seen.

## Rotation note

The account is `459252806274`, user `assetflow-capacity-run`. The policy is
deny-by-default outside the run's own resources - `RunInstances` is permitted
only for the named AMI, subnet and tag values, and P3 confirmed a production
instance cannot be terminated. A leaked key could still launch a t3.micro inside
those constraints, which is why rotation is worthwhile rather than optional.
