const axios = require("axios");
const {isNil, uniqBy, template, flatten, isEmpty} = require('lodash');
const AggregateError = require('aggregate-error');
const issueParser = require('issue-parser');
const debug = require('debug')('semantic-release:gitlab');
const resolveConfig = require('./resolve-config');
const getRepoId = require("./get-repo-id");
const getSuccessComment = require('./get-success-comment');

module.exports = async (pluginConfig, context) => {
  const {
    options: {repositoryUrl},
    commits,
    nextRelease,
    releases,
    logger,
  } = context;
  const {
    gitlabToken,
    gitlabUrl,
    gitlabApiUrl,
    successComment,
    releasedLabels
  } = resolveConfig(pluginConfig, context);

  const repoId = getRepoId(context, gitlabUrl, repositoryUrl);
  const encodedRepoId = encodeURIComponent(repoId);

  const client = axios.create({
    baseURL: gitlabApiUrl,
    headers: {'PRIVATE-TOKEN': gitlabToken}
  });

  const errors = [];

  if (successComment === false) {
    logger.log('Skip commenting on issues and pull requests.');
  } else {
    const parser = issueParser('gitlab', gitlabUrl ? {hosts: [gitlabUrl]} : {});
    const releaseInfos = releases.filter((release) => Boolean(release.name));
    const shas = commits.map(({hash}) => hash);

    const mergeRequests = uniqBy(flatten(await Promise.all(shas.map((sha) => (async () => {
      const response = await client.get(`/projects/${encodedRepoId}/repository/commits/${sha}/merge_requests`);
      return response.data;
    })()))), "iid");

    debug(
      'found merge requests: %O',
      mergeRequests.map(({iid}) => iid)
    );

    // Parse the release commits message and PRs body to find resolved issues/PRs via comment keyworkds
    const issues = [...mergeRequests.map((mergeRequest) => mergeRequest.description), ...commits.map((commit) => commit.message)].reduce(
      (issues, message) => {
        return message
          ? issues.concat(
            parser(message)
              .actions.close.filter((action) => isNil(action.slug) || action.slug === repoId)
              .map((action) => ({
                iid: Number.parseInt(action.issue, 10)
              }))
          )
          : issues;
      },
      []
    );

    debug('found issues via comments: %O', issues);

    await Promise.all(
      uniqBy([...mergeRequests, ...issues], 'iid').map(async (issue) => {
        const body = successComment
          ? template(successComment)({...context, issue})
          : getSuccessComment(issue, releaseInfos, nextRelease);

        try {
          const comment = {repoId, issue_iid: issue.iid, body};

          debug('create comment: %O', comment);

          const {data} = await client.post(issue.merge_status ? `/projects/${encodedRepoId}/merge_requests/${issue.iid}/notes` : `/projects/${encodedRepoId}/issues/${issue.iid}/notes`, {body});

          logger.log('Added comment to issue #%d: %s', issue.iid, `${gitlabUrl}/${repoId}/-/issues/${issue.iid}#note_${data.id}`);

          if (releasedLabels) {
            const labels = releasedLabels.map((label) => template(label)(context));

            await client.put(`/projects/${encodedRepoId}/issues/${issue.iid}`, {
              add_labels: labels.join(",")
            });

            logger.log('Added labels %O to issue #%d', labels, issue.iid);
          }
        } catch (error) {
          if (error.status === 403) {
            logger.error('Not allowed to add a comment to the issue #%d.', issue.iid);
          } else if (error.status === 404) {
            logger.error("Failed to add a comment to the issue #%d as it doesn't exist.", issue.iid);
          } else {
            errors.push(error);
            logger.error('Failed to add a comment to the issue #%d.', issue.iid);
            // Don't throw right away and continue to update other issues
          }
        }
      })
    );
  }

  if (errors.length > 0) {
    throw new AggregateError(errors);
  }
};