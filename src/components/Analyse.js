import PropTypes from 'prop-types'
import React, {Component} from 'react'
import {connect} from 'react-redux'
import Scroll from 'react-scroll'
import {
	Container,
	Grid,
	Header,
	Loader,
	Menu,
	Segment,
	Sticky,
} from 'semantic-ui-react'

import {fflogsApi} from 'api'
import JobIcon from 'components/ui/JobIcon'
import JOBS, {ROLES} from 'data/JOBS'
import * as Errors from 'errors'
import AVAILABLE_MODULES from 'parser/AVAILABLE_MODULES'
import Parser from 'parser/core/Parser'
import {fetchReportIfNeeded, setGlobalError} from 'store/actions'

import styles from './Analyse.module.css'

class Analyse extends Component {
	// TODO: I should really make a definitions file for this shit
	// TODO: maybe flow?
	// Also like all the functionality
	static propTypes = {
		dispatch: PropTypes.func.isRequired,
		match: PropTypes.shape({
			params: PropTypes.shape({
				code: PropTypes.string.isRequired,
				fight: PropTypes.string.isRequired,
				combatant: PropTypes.string.isRequired,
			}).isRequired,
		}).isRequired,
		report: PropTypes.shape({
			loading: PropTypes.bool.isRequired,
		}),
	}

	stickyContext = null

	resultCache = null

	constructor(props) {
		super(props)

		this.state = {
			parser: null,
			complete: false,
			activeSegment: 0,
		}

		this.stickyContext = React.createRef()
	}

	componentDidMount() {
		this.fetchData()
	}

	componentDidUpdate(prevProps/* , prevState */) {
		// TODO: do i need this? mostly url updates
		this.fetchData(prevProps)
	}

	reset() {
		console.log('TODO: reset?')
	}

	fetchData(prevProps) {
		const {dispatch, match} = this.props

		// Make sure we've got a report, then run the parse
		dispatch(fetchReportIfNeeded(match.params.code))
		this.fetchEventsAndParseIfNeeded(prevProps)
	}

	fetchEventsAndParseIfNeeded(prevProps) {
		const {
			dispatch,
			report,
			match: {params},
		} = this.props

		// TODO: actually check if needed
		const changed = !prevProps
			|| report !== prevProps.report
			|| params !== prevProps.match.params
		if (changed) {
			// TODO: does it really need to reset here?
			this.reset()

			// If we don't have everything we need, stop before we hit the api
			// TODO: more checks
			const valid = report
				&& !report.loading
				&& report.code === params.code
				&& params.fight
				&& params.combatant
			if (!valid) { return }

			// --- Sanity checks ---
			// Fight exists
			const fightId = parseInt(params.fight, 10)
			const fight = report.fights.find(fight => fight.id === fightId)
			if (!fight) {
				dispatch(setGlobalError(new Errors.NotFoundError({
					type: 'fight',
					id: fightId,
				})))
				return
			}

			// Combatant exists
			const combatantId = parseInt(params.combatant, 10)
			const combatant = report.friendlies.find(friend => friend.id === combatantId)
			if (!combatant) {
				dispatch(setGlobalError(new Errors.NotFoundError({
					type: 'friendly combatant',
					id: combatantId,
				})))
				return
			}

			// Combatant took part in fight
			if (!combatant.fights.find(fight => fight.id === fightId)) {
				dispatch(setGlobalError(new Errors.DidNotParticipateError({
					combatant: combatant.name,
					fight: fightId,
				})))
				return
			}

			// Maybe sanity check we have a parser for job? maybe a bit deeper? dunno ey
			this.fetchEventsAndParse(report, fight, combatant)
		}
	}

	async fetchEventsAndParse(report, fight, combatant) {
		// TODO: handle pets?
		// Build the base parser instance (implicitly loads core modules)
		const parser = new Parser(report, fight, combatant)

		// Look up any modules we might want
		const modules = {
			job: AVAILABLE_MODULES.JOBS[combatant.type],
			boss: AVAILABLE_MODULES.BOSSES[fight.boss],
		}

		// Load any modules we've got
		const modulePromises = []
		const loadOrder = ['boss', 'job']
		for (const group of loadOrder) {
			if (!modules[group]) { continue }
			modulePromises.push(modules[group]())
		}
		(await Promise.all(modulePromises)).forEach(({default: loadedModules}, index) => {
			modules[loadOrder[index]] = loadedModules
			parser.addModules(loadedModules)
		})

		// Finalise the module structure & push all that into state
		parser.buildModules()
		this.setState({parser})

		// TODO: Should this be somewhere else?
		// TODO: Looks like we don't need to paginate events requests any more... sure?
		const resp = await fflogsApi.get(`report/events/${report.code}`, {
			params: {
				start: fight.start_time,
				end: fight.end_time,
				actorid: combatant.id,
				// filter?
				translate: true, // probs keep same?
			},
		})
		const events = resp.data.events

		// TODO: Batch
		parser.parseEvents(events)

		this.resultCache = null
		this.setState({complete: true})
	}

	getParserResults() {
		if (!this.resultCache) {
			this.resultCache = this.state.parser.generateResults()
		}

		return this.resultCache
	}

	render() {
		const {
			parser,
			complete,
			activeSegment,
		} = this.state

		// Still loading the parser or running the parse
		// TODO: Nice loading bar and shit
		if (!parser || !complete) {
			return <Container>
				<Loader active>Loading analysis</Loader>
			</Container>
		}

		// Report's done, build output
		const job = JOBS[parser.player.type]
		const results = this.getParserResults()

		return <Container>
			<Grid>
				<Grid.Column width={4}>
					<Header
						className={[styles.sidebar, styles.header]}
						attached="top"
					>
						<JobIcon job={job} set={1}/>
						<Header.Content>
							{job.name}
							<Header.Subheader>
								{ROLES[job.role].name}
							</Header.Subheader>
						</Header.Content>
					</Header>
					<Header className={styles.header} attached="bottom">
						<img src="https://secure.xivdb.com/img/ui/enemy.png" alt="Generic enemy icon"/>
						<Header.Content>
							{parser.fight.name}
							<Header.Subheader>
								{parser.fight.zoneName}
							</Header.Subheader>
						</Header.Content>
					</Header>

					<Sticky context={this.stickyContext.current} offset={60}>
						<Menu vertical pointing secondary fluid>
							{results.map((result, index) => <Menu.Item
								// Menu.Item props
								key={index}
								active={activeSegment === index}
								as={Scroll.Link}
								// Scroll.Link props
								to={result.name}
								offset={-50}
								smooth
								spy
								onSetActive={() => this.setState({activeSegment: index})}
							>
								{result.name /* Doing manually so SUI doesn't modify my text */}
							</Menu.Item>)}
						</Menu>
					</Sticky>
				</Grid.Column>
				<Grid.Column width={12}>
					<div ref={this.stickyContext} className={styles.resultsContainer}>
						{results.map((result, index) =>
							<Segment vertical as={Scroll.Element} name={result.name} key={index}>
								<Header>{result.name}</Header>
								{result.markup}
							</Segment>
						)}
					</div>
				</Grid.Column>
			</Grid>
		</Container>
	}
}

const mapStateToProps = state => ({
	report: state.report,
})

export default connect(mapStateToProps)(Analyse)
