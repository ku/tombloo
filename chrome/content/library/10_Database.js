function Database(file) {
	this.connection = StorageService.openDatabase(file);
}

extend(Database, {
	bindParams : function(wrapper, params) {
		if(params==null)
			return;
		
		// Hash
		if(typeof(params)=='object' && params.length==null){
			var paramNames = this.getParamNames(wrapper);
			for(var i=0,len=paramNames.length ; i<len ; i++){
				var name = paramNames[i];
				var param = params[name];
				if(typeof(param)=='undefined')
					continue;
				
				if(param instanceof Date){
					wrapper.params[name] = param.getTime();
					continue;
				}
				
				wrapper.params[name] = param;
			}
			return;
		}
		
		// Array
		if(typeof(params)=='string' || params.length==null)
			params = [].concat(params);
		
		var statement = wrapper.statement;
		for(var i=0, len=statement.parameterCount ; i<len ; i++)
			statement.bindUTF8StringParameter(i, params[i]);
	},
	getParamNames : function(wrapper) {
		var paramNames = [];
		var statement = wrapper.statement;
		for (var i=0, len=statement.parameterCount ; i<len ; i++) 
			paramNames.push(statement.getParameterName(i).substr(1));
		
		return paramNames;
	},
	getColumnNames : function(wrapper) {
		var columnNames=[];
		statement = wrapper.statement;
		for(var i=0, len=statement.columnCount ; i<len ; i++)
			columnNames.push(statement.getColumnName(i));
		
		return columnNames;
	},
	getRow : function(row, columnNames){
		var result = {};
		for(var i=0,len=columnNames.length ; i<len ; i++){
			var name = columnNames[i];
			result[name] = row[name];
		}
		
		return result;
	},
})

extend(Database.prototype, {
	createStatement : function(sql) {
		return new StorageStatementWrapper(this.connection.createStatement(sql));
	},
	execute : function(sql, params) {
		sql+='';
		
		if(params && params.order){
			sql += ' ORDER BY ' + params.order;
		}
		
		if(params && params.limit){
			sql += ' LIMIT :limit OFFSET :offset';
			if(params.offset==null)
				params.offset = 0;
		}
		
		try{
			var statement = sql.initialize? sql : this.createStatement(sql);
			Database.bindParams(statement, params);
			
			var columnNames;
			var result = [];
			while (statement.step()) {
				if (!columnNames)
					columnNames = Database.getColumnNames(statement);
				
				result.push(Database.getRow(statement.row, columnNames));
			}
			return result;
		} catch(e if e==StopIteration) {
		} catch(e) {
			this.throwException(e);
		} finally {
			if(statement)
				statement.reset();
		}
	},
	transaction : function(handler) {
		var connection = this.connection;
		var error = false;
		connection.beginTransaction();
		try {
			handler();
			connection.commitTransaction();
		} catch(e) {
			error = true;
			this.throwException(e);
		} finally {
			if(error)
				connection.rollbackTransaction();
		}
	},
	throwException : function(e){
		var code = this.connection.lastError;
		var message = this.connection.lastErrorString;
		switch(code){
		case 1:
			if(message.match(/already exists$/))
				throw new Database.AlreadyExistsException(this, e);
		case 19:
			throw new Database.DuplicateKeyException(this, e);
		case 20:
			throw new Database.TypeMismatchException(this, e);
		default:
			throw new Database.DatabaseException(this, e);
		}
	},
});



/*
ConstraintViolationException
DataException
ConnectionException
LockAcquisitionException
SQLGrammarException
TableDoesNotExistException
TooManyRowsAffectedException
PropertyValueException
TransactionException
*/
[
	'DatabaseException', 
	'DuplicateKeyException', 
	'TypeMismatchException', 
	'AlreadyExistsException'].forEach(function(name){
		Database[name] = function(db, e){
			this.lastError = db.connection.lastError;
			this.lastErrorString = db.connection.lastErrorString;
			update(this, e);
			this.toString = function(){
				return this.lastErrorString;
			}
		}
	});


function Entity(def){
	def.fields = def.fields || [];
	
	var Model = function(obj){
		update(this, obj);
		this.temporary=true;
	}
	
	extend(Model.prototype, {
		save : function(){
			if(this.temporary){
				Model.insert(this);
				this.temporary=false;
			} else {
				Model.update(this);
			}
		},
		remove : function(){
			Model.deleteById(this.id);
			this.temporary = true;
		},
	});
	
	var fields = [];
	for(var field in def.fields){
		var type = def.fields[field];
		if(type=='TIMESTAMP'){
			var proto = Model.prototype;
			proto.__defineGetter__(field, new Function('return this._'+field));
			proto.__defineSetter__(field, new Function('val', 
				'this._'+field+' = typeof(val)!="object"? new Date(val) : val'
			));
		}
	}
	
	var INITIALIZE_SQL = Entity.createInitializeSQL(def);
	var INSERT_SQL     = Entity.createInsertSQL(def);
	var UPDATE_SQL     = Entity.createUpdateSQL(def);
	
	var sqlCache = {};
	
	extend(Model, {
		initialize : function(){
			Model.db.execute(INITIALIZE_SQL);
		},
		deinitialize : function(){
			return Model.db.execute(<>
				DROP TABLE {def.name} 
			</>);
		},
		insert : function(model){
			if(!(model instanceof Model))
				model = new Model(model);
			Model.db.execute(INSERT_SQL, model);
		},
		update : function(model){
			Model.db.execute(UPDATE_SQL, model);
		},
		deleteById : function(id){
			return Model.db.execute(<>
				DELETE FROM {def.name} 
				WHERE
					id = :id
			</>, id);
		},
		deleteAll : function(){
			return Model.db.execute(<>
				DELETE FROM {def.name} 
			</>);
		},
		countAll : function(){
			return Model.db.execute(<>
				SELECT count(*) AS count
				FROM {def.name} 
			</>)[0].count;
		},
		findAll : function(){
			return this.find(<>
				SELECT * 
				FROM {def.name} 
			</>);
		},
		rowToObject : function(obj){
			var model = new Model(obj);
			model.temporary = false;
			return model;
		},
		find : function(sql, params){
			return Model.db.execute(sql, params).map(Model.rowToObject);
		},
		
		__noSuchMethod__ : function (method, args) {
			if( ! method.match(/^(find|count)By/))
				return;
			
			var me = arguments.callee;
			var cache = me.cache || (me.cache = {});
			
			var sql;
			var type = RegExp.$1;
			if(method in cache){
				sql = cache[method];
			} else {
				var fields = method.substr(type.length+2).
					split('And').
					map(decapitalize);
				
				switch(type){
				case 'find':
					sql = Entity.compactSQL(<>
						SELECT * 
						FROM {def.name} 
						{Entity.createWhereClause(fields)} 
					</>)
					break;
				case 'count':
					sql = Entity.compactSQL(<>
						SELECT count(id) AS count
						FROM {def.name} 
						{Entity.createWhereClause(fields)} 
					</>)
					break;
				}
				
				cache[name] = sql;
			}
			args.unshift(sql);
			
			switch(type){
			case 'find':
				return this.find.apply(this, args);
			case 'count':
				return Model.db.execute.apply(Model.db, args)[0].count;
			}
		},
	});
	
	return Model;
}

extend(Entity, {
	createWhereClause : function(fields){
		return Entity.compactSQL(<>
			WHERE
				{fields.map(function(p){return p + '=:' + p}).join(' AND ')} 
		</>);
	},
	
	createInsertSQL : function(def){
		var fields = keys(def.fields);
		var params = fields.map(function(p){
			return ':' + p
		});
		return Entity.compactSQL(<>
			INSERT INTO {def.name} (
				{fields.join(', ')}
			) VALUES (
				{params.join(', ')}
			)
		</>);
	},
	createInitializeSQL : function(def){
		var fields = [];
		for(var p in def.fields){
			var type = def.fields[p];
			fields.push(p + ' ' + (type=='TIMESTAMP'? 'INTEGER' : type));
		}
		
		return Entity.compactSQL(<>
			CREATE TABLE IF NOT EXISTS {def.name} (
				{fields.join(', ')} 
			)
		</>);
	},
	createUpdateSQL : function(def){
		var fields =  keys(def.fields).
			filter(function(p){return p!='id'}).
			map(function(p){
				return p + '=:' + p;
			}).join(', ');
		
		return Entity.compactSQL(<>
			UPDATE {def.name} 
			SET 
				{fields} 
			WHERE 
				id = :id
		</>);
	},
	compactSQL: function(sql){
		sql+='';
		return sql.
			replace(/[\n\r]/gm,'').
			replace(/[\t ]+/g,' ').
			replace(/(^ +)|( +$)/g,'');
	},
});
